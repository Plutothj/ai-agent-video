import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { buildTencentCloudRequest, resolveTencentCloudCredentials, TencentCloudError } from '@/lib/tencent-cloud/client'

// 期望值由 Python 参考实现（TC3-HMAC-SHA256，与现网验证过的签名逻辑一致）对相同固定输入计算得出，
// 用于 TS 实现的跨语言交叉验证。
const FIXED_TIMESTAMP = 1757056000
const FIXED_CREDENTIALS = {
  secretId: 'AKIDtest123',
  secretKey: 'secrettest456',
  subAppId: 1446557570,
  region: 'ap-guangzhou',
}
const FIXED_PAYLOAD = {
  SubAppId: 1446557570,
  ModelName: 'Kling',
  ModelVersion: '3.0',
  Prompt: '一只猫在跳舞，夜景',
  OutputConfig: { Duration: 5 },
}

describe('tencent-cloud client', () => {
  describe('buildTencentCloudRequest', () => {
    it('签名与 Python 参考实现一致（含中文 payload）', () => {
      const request = buildTencentCloudRequest({
        endpoint: 'https://vod.tencentcloudapi.com',
        service: 'vod',
        action: 'CreateAigcVideoTask',
        version: '2018-07-17',
        region: 'ap-guangzhou',
        payload: FIXED_PAYLOAD,
        credentials: FIXED_CREDENTIALS,
        timestampSeconds: FIXED_TIMESTAMP,
      })

      expect(request.body).toBe(
        '{"SubAppId":1446557570,"ModelName":"Kling","ModelVersion":"3.0","Prompt":"一只猫在跳舞，夜景","OutputConfig":{"Duration":5}}',
      )
      expect(request.headers['X-TC-Action']).toBe('CreateAigcVideoTask')
      expect(request.headers['X-TC-Timestamp']).toBe(String(FIXED_TIMESTAMP))
      expect(request.headers['X-TC-Version']).toBe('2018-07-17')
      expect(request.headers['X-TC-Region']).toBe('ap-guangzhou')
      expect(request.headers['Host']).toBe('vod.tencentcloudapi.com')
      expect(request.headers['Authorization']).toBe(
        'TC3-HMAC-SHA256 Credential=AKIDtest123/2025-09-05/vod/tc3_request, '
        + 'SignedHeaders=content-type;host;x-tc-action, '
        + 'Signature=5afcebd5d34879984c9dba61505373b4afa504a198ca23ee4c1f2cc5ccdfa2b8',
      )
      expect(request.url).toBe('https://vod.tencentcloudapi.com/')
    })

    it('相同输入产生相同签名（确定性）', () => {
      const build = () => buildTencentCloudRequest({
        endpoint: 'https://vod.tencentcloudapi.com',
        service: 'vod',
        action: 'DescribeTaskDetail',
        version: '2018-07-17',
        region: 'ap-guangzhou',
        payload: { SubAppId: 1, TaskId: 'task-a' },
        credentials: FIXED_CREDENTIALS,
        timestampSeconds: FIXED_TIMESTAMP,
      })
      expect(build().headers['Authorization']).toBe(build().headers['Authorization'])
    })
  })

  describe('resolveTencentCloudCredentials', () => {
    const ENV_KEYS = ['TENCENT_VOD_SECRET_ID', 'TENCENT_VOD_SECRET_KEY', 'TENCENT_VOD_SUB_APP_ID', 'TENCENT_VOD_REGION'] as const

    beforeEach(() => {
      for (const key of ENV_KEYS) delete process.env[key]
    })

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key]
    })

    it('优先解析 apiKey 组合格式 secretId:secretKey:subAppId', () => {
      const credentials = resolveTencentCloudCredentials('AKIDabc:sk-xyz:1446557570')
      expect(credentials).toEqual({
        secretId: 'AKIDabc',
        secretKey: 'sk-xyz',
        subAppId: 1446557570,
        region: 'ap-guangzhou',
      })
    })

    it('apiKey 为普通密钥时回退环境变量', () => {
      process.env.TENCENT_VOD_SECRET_ID = 'AKIDenv'
      process.env.TENCENT_VOD_SECRET_KEY = 'sk-env'
      process.env.TENCENT_VOD_SUB_APP_ID = '1500067827'
      process.env.TENCENT_VOD_REGION = 'ap-beijing'
      const credentials = resolveTencentCloudCredentials('placeholder')
      expect(credentials).toEqual({
        secretId: 'AKIDenv',
        secretKey: 'sk-env',
        subAppId: 1500067827,
        region: 'ap-beijing',
      })
    })

    it('缺少凭据时抛出带指引的错误', () => {
      expect(() => resolveTencentCloudCredentials('placeholder')).toThrow('TENCENT_CREDENTIALS_MISSING')
    })

    it('组合格式 subAppId 非数字时回退环境变量', () => {
      process.env.TENCENT_VOD_SECRET_ID = 'AKIDenv'
      process.env.TENCENT_VOD_SECRET_KEY = 'sk-env'
      process.env.TENCENT_VOD_SUB_APP_ID = '1500067827'
      const credentials = resolveTencentCloudCredentials('AKIDabc:sk-xyz:not-a-number')
      expect(credentials.secretId).toBe('AKIDenv')
    })
  })

  describe('TencentCloudError', () => {
    it('包含 action / code / message', () => {
      const error = new TencentCloudError({
        action: 'CreateAigcVideoTask',
        code: 'RequestLimitExceeded',
        message: '并发超限',
        requestId: 'req-1',
      })
      expect(error.message).toContain('CreateAigcVideoTask')
      expect(error.message).toContain('RequestLimitExceeded')
      expect(error.code).toBe('RequestLimitExceeded')
      expect(error.requestId).toBe('req-1')
    })
  })
})
