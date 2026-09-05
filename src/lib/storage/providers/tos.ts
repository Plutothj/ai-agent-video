import { logError as _ulogError } from '@/lib/logging/core'
import { StorageConfigError } from '@/lib/storage/errors'
import type { DeleteObjectsResult, SignedUrlParams, StorageProvider, UploadObjectParams, UploadObjectResult } from '@/lib/storage/types'
import { requireEnv, streamToBuffer, toFetchableUrl } from '@/lib/storage/utils'

/**
 * 火山引擎 TOS 存储 provider（Volcengine Torch Object Storage）
 *
 * 对齐 drama 项目约定：
 * - 所有对象存放在 TOS_MEDIA_PREFIX 前缀目录下（默认 media_gen），避免与其他业务互相覆盖
 * - 配置 TOS_PUBLIC_BASE_URL（CDN/自定义域名，如 https://file.example.com）时，
 *   对象通过公开 URL 直接访问；未配置时回退 SDK 预签名 URL
 * - 凭据：TOS_ACCESS_KEY_ID / TOS_SECRET_ACCESS_KEY（静态 AK/SK）
 */

const DEFAULT_TOS_REGION = 'cn-beijing'
const DEFAULT_TOS_ENDPOINT = 'tos-cn-beijing.volces.com'
const DEFAULT_TOS_MEDIA_PREFIX = 'media_gen'

type TosClientLike = {
  putObject(input: Record<string, unknown>): Promise<{ data?: unknown }>
  getObject(input: Record<string, unknown>): Promise<{ data?: { content?: unknown } }>
  deleteObject(input: Record<string, unknown>): Promise<{ data?: unknown }>
  deleteMultiObjects(input: Record<string, unknown>): Promise<{ data?: { Deleted?: unknown[]; Error?: unknown[] } }>
  getPreSignedUrl(input: Record<string, unknown>): string
}

type TosSdkModule = {
  TosClient: new (config: Record<string, unknown>) => TosClientLike
  TOS?: unknown
  default?: unknown
}

function readTrimmedEnv(name: string): string {
  return (process.env[name] || '').trim()
}

export class TosStorageProvider implements StorageProvider {
  readonly kind = 'tos' as const

  private readonly bucket: string
  private readonly region: string
  private readonly endpoint: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly publicBaseUrl: string
  private readonly mediaPrefix: string
  private clientPromise: Promise<TosClientLike> | null = null

  constructor() {
    this.bucket = requireEnv('TOS_BUCKET')
    this.accessKeyId = readTrimmedEnv('TOS_ACCESS_KEY_ID') || readTrimmedEnv('TOS_ACCESS_KEY')
    this.secretAccessKey = readTrimmedEnv('TOS_SECRET_ACCESS_KEY') || readTrimmedEnv('TOS_SECRET_KEY')
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new StorageConfigError(
        'Missing required environment variables: TOS_ACCESS_KEY_ID / TOS_SECRET_ACCESS_KEY',
      )
    }
    this.region = readTrimmedEnv('TOS_REGION') || DEFAULT_TOS_REGION
    this.endpoint = readTrimmedEnv('TOS_ENDPOINT') || DEFAULT_TOS_ENDPOINT
    this.publicBaseUrl = readTrimmedEnv('TOS_PUBLIC_BASE_URL').replace(/\/+$/, '')
    this.mediaPrefix = readTrimmedEnv('TOS_MEDIA_PREFIX') || DEFAULT_TOS_MEDIA_PREFIX
  }

  private async loadSdk(): Promise<TosSdkModule> {
    return await import('@volcengine/tos-sdk') as unknown as TosSdkModule
  }

  private async getClient(): Promise<TosClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = await this.loadSdk()
        const Client = sdk.TosClient || (sdk.default as TosSdkModule['TosClient']) || sdk.TOS
        if (!Client) {
          throw new Error('TOS SDK_LOAD_FAILED: @volcengine/tos-sdk 未导出 TosClient')
        }
        return new Client({
          region: this.region,
          endpoint: this.endpoint,
          accessKeyId: this.accessKeyId,
          accessKeySecret: this.secretAccessKey,
          requestTimeout: 120_000,
          maxRetryCount: 3,
        })
      })()
    }
    return await this.clientPromise
  }

  /** 业务 key（库内存储形态）→ TOS 对象 key（带 media 前缀） */
  private toTosKey(key: string): string {
    if (!this.mediaPrefix || key.startsWith(`${this.mediaPrefix}/`)) {
      return key
    }
    return `${this.mediaPrefix}/${key}`
  }

  /** TOS 对象 key → 业务 key */
  private toBusinessKey(tosKey: string): string {
    if (this.mediaPrefix && tosKey.startsWith(`${this.mediaPrefix}/`)) {
      return tosKey.slice(this.mediaPrefix.length + 1)
    }
    return tosKey
  }

  /**
   * 公开访问 URL（配置了 TOS_PUBLIC_BASE_URL 时生效）。
   * 未配置返回 null，调用方回退预签名 URL。
   */
  getDirectPublicUrl(key: string): string | null {
    if (!this.publicBaseUrl) return null
    return `${this.publicBaseUrl}/${this.toTosKey(key)}`
  }

  async uploadObject(params: UploadObjectParams): Promise<UploadObjectResult> {
    const client = await this.getClient()
    await client.putObject({
      bucket: this.bucket,
      key: this.toTosKey(params.key),
      body: params.body,
      ...(params.contentType ? { contentType: params.contentType } : {}),
    })
    return { key: params.key }
  }

  async deleteObject(key: string): Promise<void> {
    const client = await this.getClient()
    await client.deleteObject({
      bucket: this.bucket,
      key: this.toTosKey(key),
    })
  }

  async deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
    const validKeys = keys.filter((key) => typeof key === 'string' && key.trim().length > 0)
    if (validKeys.length === 0) {
      return { success: 0, failed: 0 }
    }

    const client = await this.getClient()
    const result = await client.deleteMultiObjects({
      bucket: this.bucket,
      quiet: true,
      objects: validKeys.map((key) => ({ key: this.toTosKey(key) })),
    })
    const deleted = Array.isArray(result.data?.Deleted) ? result.data!.Deleted!.length : 0
    const failed = Array.isArray(result.data?.Error) ? result.data!.Error!.length : 0
    return { success: deleted, failed }
  }

  async getSignedObjectUrl(params: SignedUrlParams): Promise<string> {
    const publicUrl = this.getDirectPublicUrl(params.key)
    if (publicUrl) {
      return publicUrl
    }
    const client = await this.getClient()
    return client.getPreSignedUrl({
      bucket: this.bucket,
      key: this.toTosKey(params.key),
      expires: params.expiresInSeconds,
    })
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const client = await this.getClient()
    const result = await client.getObject({
      bucket: this.bucket,
      key: this.toTosKey(key),
    })
    return await streamToBuffer(result.data?.content)
  }

  extractStorageKey(input: string | null | undefined): string | null {
    if (!input) return null

    // /api/storage/sign?key=... 形式：直接取 query 参数
    if (input.startsWith('/api/storage/sign') || input.includes('/api/storage/sign?')) {
      try {
        const parsed = new URL(input, 'http://localhost')
        const key = parsed.searchParams.get('key')
        return key ? this.toBusinessKey(key) : null
      } catch {
        return null
      }
    }

    if (!input.startsWith('http') && !input.startsWith('/')) {
      return this.toBusinessKey(input)
    }

    try {
      const parsed = new URL(input, 'http://localhost')
      let pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
      const bucketPrefix = `${this.bucket}/`
      if (pathname.startsWith(bucketPrefix)) {
        pathname = pathname.slice(bucketPrefix.length)
      }
      if (parsed.hostname.startsWith(`${this.bucket}.`) && pathname) {
        return this.toBusinessKey(pathname)
      }
      if (!pathname) return null
      return this.toBusinessKey(pathname)
    } catch {
      return null
    }
  }

  toFetchableUrl(inputUrl: string): string {
    return toFetchableUrl(inputUrl)
  }

  generateUniqueKey(params: { prefix: string; ext: string }): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2, 8)
    return `images/${params.prefix}-${timestamp}-${random}.${params.ext}`
  }
}

// 供上层日志使用（与 minio provider 的错误记录风格保持一致）
export function logTosError(scope: string, error: unknown): void {
  _ulogError(`[TOS ${scope}]`, error)
}
