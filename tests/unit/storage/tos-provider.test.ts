import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { TosStorageProvider } from '@/lib/storage/providers/tos'
import { createStorageProvider } from '@/lib/storage/factory'

const TOS_ENV_KEYS = [
  'TOS_BUCKET',
  'TOS_ACCESS_KEY_ID',
  'TOS_SECRET_ACCESS_KEY',
  'TOS_ACCESS_KEY',
  'TOS_SECRET_KEY',
  'TOS_REGION',
  'TOS_ENDPOINT',
  'TOS_PUBLIC_BASE_URL',
  'TOS_MEDIA_PREFIX',
  'STORAGE_TYPE',
] as const

function applyTosEnv(overrides: Partial<Record<(typeof TOS_ENV_KEYS)[number], string>> = {}) {
  process.env.TOS_BUCKET = 'test-bucket'
  process.env.TOS_ACCESS_KEY_ID = 'ak-test'
  process.env.TOS_SECRET_ACCESS_KEY = 'sk-test'
  process.env.TOS_REGION = 'cn-beijing'
  process.env.TOS_ENDPOINT = 'tos-cn-beijing.volces.com'
  process.env.TOS_PUBLIC_BASE_URL = 'https://file.example.com'
  process.env.TOS_MEDIA_PREFIX = 'media_gen'
  for (const [key, value] of Object.entries(overrides)) {
    if (value === '') {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('TosStorageProvider', () => {
  beforeEach(() => {
    for (const key of TOS_ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const key of TOS_ENV_KEYS) delete process.env[key]
  })

  it('缺少 AK/SK 时抛出配置错误', () => {
    applyTosEnv({ TOS_ACCESS_KEY_ID: '', TOS_SECRET_ACCESS_KEY: '' })
    expect(() => new TosStorageProvider()).toThrow('TOS_ACCESS_KEY_ID')
  })

  it('公开域名场景：getDirectPublicUrl 拼接 media 前缀', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.getDirectPublicUrl('images/panel-1.png'))
      .toBe('https://file.example.com/media_gen/images/panel-1.png')
  })

  it('未配置公开域名时 getDirectPublicUrl 返回 null', () => {
    applyTosEnv({ TOS_PUBLIC_BASE_URL: '' })
    const provider = new TosStorageProvider()
    expect(provider.getDirectPublicUrl('images/panel-1.png')).toBeNull()
  })

  it('extractStorageKey：裸 key / 带 media 前缀 key 均归一化为业务 key', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.extractStorageKey('images/panel-1.png')).toBe('images/panel-1.png')
    expect(provider.extractStorageKey('media_gen/images/panel-1.png')).toBe('images/panel-1.png')
  })

  it('extractStorageKey：公开域名 URL 剥离前缀还原业务 key', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.extractStorageKey('https://file.example.com/media_gen/video/proj/1.mp4'))
      .toBe('video/proj/1.mp4')
  })

  it('extractStorageKey：签名路由 URL 取 query 参数', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.extractStorageKey('/api/storage/sign?key=voice%2Fa%2Fb.wav&expires=3600'))
      .toBe('voice/a/b.wav')
  })

  it('extractStorageKey：虚拟主机风格 URL 剥离桶名', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.extractStorageKey('https://test-bucket.tos-cn-beijing.volces.com/media_gen/images/a.jpg'))
      .toBe('images/a.jpg')
  })

  it('extractStorageKey：空值与无效输入返回 null', () => {
    applyTosEnv()
    const provider = new TosStorageProvider()
    expect(provider.extractStorageKey(null)).toBeNull()
    expect(provider.extractStorageKey('')).toBeNull()
  })
})

describe('storage factory tos type', () => {
  beforeEach(() => {
    for (const key of TOS_ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const key of TOS_ENV_KEYS) delete process.env[key]
  })

  it('STORAGE_TYPE=tos 创建 TosStorageProvider', () => {
    applyTosEnv()
    const provider = createStorageProvider({ storageType: 'tos' })
    expect(provider.kind).toBe('tos')
  })

  it('STORAGE_TYPE 不支持的值抛出 StorageConfigError', () => {
    expect(() => createStorageProvider({ storageType: 'unknown-type' })).toThrow('Unsupported STORAGE_TYPE')
  })
})
