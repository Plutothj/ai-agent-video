/**
 * 腾讯云 API 3.0 客户端（TC3-HMAC-SHA256 签名）
 *
 * 覆盖 VOD AIGC（生图/生视频/生音频/台词配音）等按接口版本调用的腾讯云 API。
 * 协议参考：https://cloud.tencent.com/document/api/266/31756
 *
 * 凭据来源（优先级）：
 * 1. 配置中心 provider.apiKey，格式 `secretId:secretKey:subAppId`
 * 2. 环境变量 TENCENT_VOD_SECRET_ID / TENCENT_VOD_SECRET_KEY / TENCENT_VOD_SUB_APP_ID
 */

import { createHash, createHmac } from 'node:crypto'
import { logError as _ulogError } from '@/lib/logging/core'

export interface TencentCloudCredentials {
  secretId: string
  secretKey: string
  subAppId: number
  region: string
}

export class TencentCloudError extends Error {
  readonly code: string
  readonly requestId?: string

  constructor(params: { action: string; code: string; message: string; requestId?: string }) {
    super(`腾讯云 ${params.action} 失败 ${params.code}: ${params.message}`)
    this.name = 'TencentCloudError'
    this.code = params.code
    this.requestId = params.requestId
  }
}

function readEnvCredential(name: string): string {
  return (process.env[name] || '').trim()
}

/**
 * 解析腾讯云凭据。
 * providerApiKey 允许 `secretId:secretKey:subAppId` 组合格式（存于配置中心，落库已加密）；
 * 未提供或格式不符时回退到环境变量。
 */
export function resolveTencentCloudCredentials(providerApiKey?: string): TencentCloudCredentials {
  const trimmed = (providerApiKey || '').trim()
  if (trimmed && trimmed.includes(':')) {
    const parts = trimmed.split(':').map((part) => part.trim())
    if (parts.length === 3 && parts[0] && parts[1] && /^\d+$/.test(parts[2])) {
      return {
        secretId: parts[0],
        secretKey: parts[1],
        subAppId: Number.parseInt(parts[2], 10),
        region: readEnvCredential('TENCENT_VOD_REGION') || 'ap-guangzhou',
      }
    }
  }

  const secretId = readEnvCredential('TENCENT_VOD_SECRET_ID')
  const secretKey = readEnvCredential('TENCENT_VOD_SECRET_KEY')
  const subAppIdRaw = readEnvCredential('TENCENT_VOD_SUB_APP_ID')
  if (!secretId || !secretKey || !subAppIdRaw) {
    throw new Error(
      'TENCENT_CREDENTIALS_MISSING: 请在配置中心为腾讯云 provider 填入 apiKey（格式 secretId:secretKey:subAppId），'
      + '或配置环境变量 TENCENT_VOD_SECRET_ID / TENCENT_VOD_SECRET_KEY / TENCENT_VOD_SUB_APP_ID',
    )
  }
  if (!/^\d+$/.test(subAppIdRaw)) {
    throw new Error('TENCENT_CREDENTIALS_INVALID: TENCENT_VOD_SUB_APP_ID 必须为数字')
  }
  return {
    secretId,
    secretKey,
    subAppId: Number.parseInt(subAppIdRaw, 10),
    region: readEnvCredential('TENCENT_VOD_REGION') || 'ap-guangzhou',
  }
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function hmacSha256(key: Buffer | string, content: string): Buffer {
  return createHmac('sha256', key).update(content, 'utf8').digest()
}

interface SignedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 构造一次 TC3-HMAC-SHA256 签名的腾讯云 API 3.0 请求。
 */
export function buildTencentCloudRequest(params: {
  endpoint: string
  service: string
  action: string
  version: string
  region?: string
  payload: Record<string, unknown>
  credentials: TencentCloudCredentials
  timestampSeconds?: number
}): SignedRequest {
  const { endpoint, service, action, version, region, payload, credentials } = params
  const host = endpoint.split('//')[1] || endpoint
  const body = JSON.stringify(payload)
  const timestamp = params.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

  // 1. CanonicalRequest（AIGC 全部 POST JSON，querystring 为空）
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8`,
    `host:${host}`,
    `x-tc-action:${action.toLowerCase()}`,
    '',
    'content-type;host;x-tc-action',
    sha256Hex(body),
  ].join('\n')

  // 2. StringToSign
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    `${date}/${service}/tc3_request`,
    sha256Hex(canonicalRequest),
  ].join('\n')

  // 3. 派生签名密钥
  const secretDate = hmacSha256(`TC3${credentials.secretKey}`, date)
  const secretService = hmacSha256(secretDate, service)
  const secretSigning = hmacSha256(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')

  // 4. Authorization
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${date}/${service}/tc3_request`,
    'SignedHeaders=content-type;host;x-tc-action',
    `Signature=${signature}`,
  ].join(', ')

  return {
    url: `${endpoint.replace(/\/+$/, '')}/`,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      ...(region ? { 'X-TC-Region': region } : {}),
    },
    body,
  }
}

interface TencentCloudResponseEnvelope {
  Response?: {
    Error?: { Code?: string; Message?: string }
    RequestId?: string
    [key: string]: unknown
  }
}

/**
 * 调用腾讯云 VOD API（vod.tencentcloudapi.com / 2018-07-17）。
 * 业务错误（HTTP 200 但 Response.Error 存在）抛出 TencentCloudError。
 */
export async function callTencentVod(params: {
  action: string
  payload: Record<string, unknown>
  credentials: TencentCloudCredentials
  timeoutMs?: number
}): Promise<Record<string, unknown>> {
  const request = buildTencentCloudRequest({
    endpoint: 'https://vod.tencentcloudapi.com',
    service: 'vod',
    action: params.action,
    version: '2018-07-17',
    region: params.credentials.region,
    payload: params.payload,
    credentials: params.credentials,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000)
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
  } catch (error: unknown) {
    _ulogError(`[Tencent VOD ${params.action}] 请求异常:`, error)
    throw error
  } finally {
    clearTimeout(timer)
  }

  const rawText = await response.text().catch(() => '')
  if (!response.ok) {
    throw new TencentCloudError({
      action: params.action,
      code: `HTTP_${response.status}`,
      message: rawText.slice(0, 300) || response.statusText,
    })
  }

  let parsed: TencentCloudResponseEnvelope
  try {
    parsed = JSON.parse(rawText) as TencentCloudResponseEnvelope
  } catch {
    throw new TencentCloudError({
      action: params.action,
      code: 'RESPONSE_INVALID',
      message: `响应不是有效 JSON: ${rawText.slice(0, 200)}`,
    })
  }

  const responsePayload = parsed.Response || {}
  if (responsePayload.Error) {
    throw new TencentCloudError({
      action: params.action,
      code: responsePayload.Error.Code || 'UNKNOWN',
      message: responsePayload.Error.Message || '未知错误',
      requestId: responsePayload.RequestId,
    })
  }

  return responsePayload
}
