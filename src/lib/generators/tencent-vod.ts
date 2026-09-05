import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
/**
 * 腾讯云 VOD AIGC 生成器（生图 / 生视频）
 *
 * 接口：CreateAigcVideoTask / CreateAigcImageTask（异步任务，TaskId + 轮询 DescribeTaskDetail）
 * 参考：https://cloud.tencent.com/document/api/266/31773
 *
 * 轮询接入见 src/lib/async-poll.ts（externalId 格式 TENCENT:VIDEO:{taskId} / TENCENT:IMAGE:{taskId}）。
 *
 * ⚠️ 腾讯云 AIGC 仅接受公网可访问的资源 URL（FileInfos 不支持 base64），
 * 首帧/尾帧/参考图会自动转存到对象存储并生成签名 URL，
 * 要求 MinIO/COS 端点对腾讯云服务器可达。
 */

import { BaseImageGenerator, BaseVideoGenerator } from './base'
import type { GenerateResult, ImageGenerateParams, VideoGenerateParams } from './base'
import { getProviderConfig } from '@/lib/api-config'
import { callTencentVod, resolveTencentCloudCredentials } from '@/lib/tencent-cloud/client'
import { generateUniqueKey, getSignedUrl, uploadObject } from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

// ==================== 模型规格（与 drama 生产库 ai_model / ai_video_model 对齐） ====================

interface TencentVideoModelSpec {
    modelName: string
    modelVersion: string
    minDuration: number
    maxDuration: number
    /** generateAudio=true 时允许的时长范围（如 Kling 3.0 开音频仅支持 5~10 秒） */
    audioMinDuration?: number
    audioMaxDuration?: number
    defaultDuration: number
    resolutions: readonly string[]
    aspectRatios: readonly string[]
    supportGenerateAudio: boolean
    supportLastFrame: boolean
}

// 规格来源：tsadmin.ai_video_model + ai_video_model_size（状态与约束为现网实测值）
const TENCENT_VIDEO_MODEL_SPECS: Record<string, TencentVideoModelSpec> = {
    'kling-3.0': {
        modelName: 'Kling',
        modelVersion: '3.0',
        minDuration: 3,
        maxDuration: 15,
        audioMinDuration: 5,
        audioMaxDuration: 10,
        defaultDuration: 5,
        resolutions: ['720P', '1080P'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'kling-3.0-omni': {
        modelName: 'Kling',
        modelVersion: '3.0-Omni',
        minDuration: 3,
        maxDuration: 15,
        defaultDuration: 5,
        resolutions: ['720P', '1080P'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'vs-2.0': {
        modelName: 'VS',
        modelVersion: '2.0',
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        resolutions: ['480P', '720P', '1080P'],
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'vs-2.5': {
        modelName: 'VS',
        modelVersion: '2.5',
        minDuration: 4,
        maxDuration: 30,
        defaultDuration: 5,
        resolutions: ['480P', '720P', '1080P'],
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'vs-2.0-mini': {
        modelName: 'VS',
        modelVersion: '2.0-mini',
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        resolutions: ['480P', '720P', '1080P'],
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'hailuo-h3': {
        modelName: 'Hailuo',
        modelVersion: 'H3',
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        resolutions: ['2K', '4K'],
        aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
    'wan-3.0': {
        modelName: 'Wan',
        modelVersion: '3.0',
        minDuration: 2,
        maxDuration: 30,
        defaultDuration: 5,
        resolutions: ['480P', '720P'],
        aspectRatios: ['9:16', '16:9'],
        supportGenerateAudio: true,
        supportLastFrame: true,
    },
}

interface TencentImageModelSpec {
    modelName: string
    modelVersion: string
    maxReferenceImages: number
    aspectRatios: readonly string[]
}

// 规格来源：tsadmin.ai_model + ai_model_size
const TENCENT_IMAGE_MODEL_SPECS: Record<string, TencentImageModelSpec> = {
    'gg-3.0': {
        modelName: 'GG',
        modelVersion: '3.0',
        maxReferenceImages: 14,
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    },
    'gg-3.1': {
        modelName: 'GG',
        modelVersion: '3.1',
        maxReferenceImages: 14,
        aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    },
    'gg-3.1-lite': {
        modelName: 'GG',
        modelVersion: '3.1-lite',
        maxReferenceImages: 14,
        aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    },
    'og-image2-medium': {
        modelName: 'OG',
        modelVersion: 'image2_medium',
        maxReferenceImages: 14,
        aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '16:9', '9:16', '21:9', '9:21'],
    },
    'og-image2-high': {
        modelName: 'OG',
        modelVersion: 'image2_high',
        maxReferenceImages: 14,
        aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '16:9', '9:16', '21:9', '9:21'],
    },
}

// 图片像素范围（腾讯云约束：宽高被 16 整除，总像素 655360~8294400）
const IMAGE_MIN_TOTAL_PIXELS = 655360
const IMAGE_MAX_TOTAL_PIXELS = 8294400
const IMAGE_PIXEL_STEP = 16
const IMAGE_TOTAL_PIXELS_BY_RESOLUTION: Record<string, number> = {
    '1k': 1024 * 1024,
    '2k': 2048 * 2048,
    '4k': IMAGE_MAX_TOTAL_PIXELS,
}

interface TencentVideoOptions {
    modelId?: string
    modelVersion?: string
    duration?: number
    resolution?: string
    generationMode?: string
    generateAudio?: boolean
    lastFrameImageUrl?: string
    aspectRatio?: string
    fps?: number
    seed?: number
    [key: string]: unknown
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function normalizeVideoResolution(raw: string): string {
    const normalized = raw.trim().toUpperCase()
    if (/^\d+P$/.test(normalized) || normalized === '2K' || normalized === '4K') {
        return normalized
    }
    throw new Error(`TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: resolution=${raw}`)
}

function getVideoModelSpec(modelId: string): TencentVideoModelSpec {
    const spec = TENCENT_VIDEO_MODEL_SPECS[modelId]
    if (!spec) {
        throw new Error(`TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: modelId=${modelId}`)
    }
    return spec
}

async function resolveTencentResourceUrl(input: string): Promise<string> {
    const value = input.trim()
    if (value.startsWith('http://') || value.startsWith('https://')) {
        return value
    }
    if (value.startsWith('data:')) {
        // data URL → 转存对象存储，生成签名 URL（腾讯云服务器需要公网可访问）
        const commaIndex = value.indexOf(',')
        const header = value.slice(0, commaIndex)
        const base64 = value.slice(commaIndex + 1)
        const mimeMatch = /data:([^;]+)/.exec(header)
        const mime = (mimeMatch?.[1] || 'image/png').toLowerCase()
        const ext = mime.includes('jpeg') || mime.includes('jpg')
            ? 'jpg'
            : mime.includes('webp')
                ? 'webp'
                : mime.includes('mp4')
                    ? 'mp4'
                    : 'png'
        const buffer = Buffer.from(base64, 'base64')
        const key = await uploadObject(buffer, generateUniqueKey('tmp/tencent-vod', ext))
        return getSignedUrl(key, 7200)
    }

    const storageKey = await resolveStorageKeyFromMediaValue(value)
    if (storageKey) {
        return getSignedUrl(storageKey, 7200)
    }
    throw new Error(`TENCENT_RESOURCE_URL_UNRESOLVABLE: ${value.slice(0, 120)}`)
}

function buildVideoFileInfos(urls: string[]): Array<{ Type: 'Url'; Url: string; Category: 'Image'; Usage: 'Reference' }> {
    // 腾讯云 FileInfos 仅允许 Type/Url/Category/Usage 四个字段，禁止冗余字段
    return urls.map((url) => ({ Type: 'Url' as const, Url: url, Category: 'Image' as const, Usage: 'Reference' as const }))
}

// ==================== 视频生成器 ====================

export class TencentVodVideoGenerator extends BaseVideoGenerator {
    protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
        const { userId, imageUrl, prompt = '', options = {} } = params
        const logPrefix = '[Tencent VOD Video]'

        const { apiKey } = await getProviderConfig(userId, 'tencent-vod')
        const credentials = resolveTencentCloudCredentials(apiKey)

        const {
            modelId,
            modelVersion,
            duration,
            resolution,
            generationMode: rawGenerationMode,
            generateAudio,
            lastFrameImageUrl,
            aspectRatio,
            seed,
        } = options as TencentVideoOptions
        if (!modelId) {
            throw new Error('TENCENT_VIDEO_OPTION_REQUIRED: modelId')
        }
        const spec = getVideoModelSpec(modelId)

        const hasFirstFrame = isNonEmptyString(imageUrl)
        const hasLastFrame = isNonEmptyString(lastFrameImageUrl)
        const inferredMode = hasLastFrame ? 'firstlastframe' : 'normal'
        const generationMode = isNonEmptyString(rawGenerationMode) ? rawGenerationMode : inferredMode
        if (generationMode !== 'normal' && generationMode !== 'firstlastframe') {
            throw new Error(`TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: generationMode=${String(rawGenerationMode)}`)
        }
        if (generationMode === 'firstlastframe') {
            if (!spec.supportLastFrame) {
                throw new Error(`TENCENT_VIDEO_OPTION_UNSUPPORTED: generationMode=firstlastframe for ${modelId}`)
            }
            if (!hasFirstFrame || !hasLastFrame) {
                throw new Error('TENCENT_VIDEO_OPTION_REQUIRED: firstFrameImage 和 lastFrameImageUrl 在首尾帧模式下均必填')
            }
        }

        const resolvedDuration = typeof duration === 'number' ? Math.round(duration) : spec.defaultDuration
        if (resolvedDuration < spec.minDuration || resolvedDuration > spec.maxDuration) {
            throw new Error(
                `TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: duration=${resolvedDuration}（${modelId} 支持 ${spec.minDuration}~${spec.maxDuration} 秒）`,
            )
        }

        // Kling 3.0 等模型开启音频生成时时长范围受限（来源 ai_video_model_size）
        if (generateAudio === true && typeof spec.audioMinDuration === 'number' && typeof spec.audioMaxDuration === 'number') {
            if (resolvedDuration < spec.audioMinDuration || resolvedDuration > spec.audioMaxDuration) {
                throw new Error(
                    `TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: duration=${resolvedDuration}（${modelId} 开启音频时支持 ${spec.audioMinDuration}~${spec.audioMaxDuration} 秒）`,
                )
            }
        }

        const resolvedResolution = resolution ? normalizeVideoResolution(resolution) : spec.resolutions[0]
        if (!spec.resolutions.includes(resolvedResolution)) {
            throw new Error(`TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: resolution=${resolvedResolution} for ${modelId}`)
        }

        if (aspectRatio && !spec.aspectRatios.includes(aspectRatio.trim())) {
            throw new Error(`TENCENT_VIDEO_OPTION_VALUE_UNSUPPORTED: aspectRatio=${aspectRatio} for ${modelId}`)
        }

        if (generateAudio === true && !spec.supportGenerateAudio) {
            throw new Error(`TENCENT_VIDEO_OPTION_UNSUPPORTED: generateAudio for ${modelId}`)
        }

        _ulogInfo(
            `${logPrefix} 提交任务 model=${modelId} mode=${generationMode} duration=${resolvedDuration}s resolution=${resolvedResolution}`,
        )

        const payload: Record<string, unknown> = {
            SubAppId: credentials.subAppId,
            ModelName: spec.modelName,
            ModelVersion: isNonEmptyString(modelVersion) ? modelVersion.trim() : spec.modelVersion,
            Prompt: prompt,
            EnhancePrompt: 'Enabled',
            OutputConfig: {
                StorageMode: 'Temporary',
                Duration: resolvedDuration,
                Resolution: resolvedResolution,
                ...(aspectRatio ? { AspectRatio: aspectRatio.trim() } : {}),
                ...(spec.supportGenerateAudio
                    ? { AudioGeneration: generateAudio === true ? 'Enabled' : 'Disabled' }
                    : {}),
                EnableBGM: 'Disabled',
                InputComplianceCheck: 'Disabled',
                OutputComplianceCheck: 'Disabled',
                PersonGeneration: 'AllowAdult',
                ...(typeof seed === 'number' ? { Seed: seed } : {}),
            },
        }

        if (hasFirstFrame) {
            const firstFrameUrl = await resolveTencentResourceUrl(imageUrl)
            payload.FileInfos = buildVideoFileInfos([firstFrameUrl])
        }
        if (generationMode === 'firstlastframe' && hasLastFrame) {
            payload.LastFrameUrl = await resolveTencentResourceUrl(lastFrameImageUrl)
        }

        try {
            const response = await callTencentVod({
                action: 'CreateAigcVideoTask',
                payload,
                credentials,
                timeoutMs: 60_000,
            })
            const taskId = typeof response.TaskId === 'string' ? response.TaskId : ''
            if (!taskId) {
                _ulogError(`${logPrefix} 响应中缺少 TaskId:`, response)
                throw new Error('TENCENT_VIDEO_SUBMIT_FAILED: 未返回 TaskId')
            }
            _ulogInfo(`${logPrefix} 任务已提交 TaskId=${taskId}`)
            return {
                success: true,
                async: true,
                requestId: taskId,
                externalId: `TENCENT:VIDEO:${taskId}`,
            }
        } catch (error: unknown) {
            _ulogError(`${logPrefix} 提交失败:`, error)
            throw error
        }
    }
}

// ==================== 图片生成器 ====================

function computeImageSize(resolution: string | undefined, aspectRatio: string | undefined): string {
    const totalPixels = IMAGE_TOTAL_PIXELS_BY_RESOLUTION[(resolution || '1k').trim().toLowerCase()]
        ?? IMAGE_TOTAL_PIXELS_BY_RESOLUTION['1k']

    const ratioMatch = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec((aspectRatio || '1:1').trim())
    const ratioW = ratioMatch ? Number.parseFloat(ratioMatch[1]) : 1
    const ratioH = ratioMatch ? Number.parseFloat(ratioMatch[2]) : 1

    const snapToStep = (value: number) => Math.max(IMAGE_PIXEL_STEP, Math.round(value / IMAGE_PIXEL_STEP) * IMAGE_PIXEL_STEP)
    let width = snapToStep(Math.sqrt(totalPixels * (ratioW / ratioH)))
    let height = snapToStep(Math.sqrt(totalPixels * (ratioH / ratioW)))

    let actualTotal = width * height
    if (actualTotal > IMAGE_MAX_TOTAL_PIXELS) {
        const scale = Math.sqrt(IMAGE_MAX_TOTAL_PIXELS / actualTotal)
        width = snapToStep(width * scale)
        height = snapToStep(height * scale)
        actualTotal = width * height
    }
    if (actualTotal < IMAGE_MIN_TOTAL_PIXELS) {
        const scale = Math.sqrt(IMAGE_MIN_TOTAL_PIXELS / actualTotal)
        width = snapToStep(width * scale)
        height = snapToStep(height * scale)
    }
    return `${width}x${height}`
}

export class TencentVodImageGenerator extends BaseImageGenerator {
    protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
        const { userId, prompt, referenceImages = [], options = {} } = params
        const logPrefix = '[Tencent VOD Image]'

        const { apiKey } = await getProviderConfig(userId, 'tencent-vod')
        const credentials = resolveTencentCloudCredentials(apiKey)

        const modelId = isNonEmptyString(options.modelId) ? options.modelId.trim() : 'og-image2-medium'
        const spec = TENCENT_IMAGE_MODEL_SPECS[modelId]
        if (!spec) {
            throw new Error(`TENCENT_IMAGE_OPTION_VALUE_UNSUPPORTED: modelId=${modelId}`)
        }

        const rawAspectRatio = isNonEmptyString(options.aspectRatio) ? options.aspectRatio.trim() : '1:1'
        if (!spec.aspectRatios.includes(rawAspectRatio)) {
            throw new Error(`TENCENT_IMAGE_OPTION_VALUE_UNSUPPORTED: aspectRatio=${rawAspectRatio} for ${modelId}`)
        }

        const sizeOverride = isNonEmptyString(options.size) ? options.size.trim() : ''
        const size = sizeOverride || computeImageSize(
            isNonEmptyString(options.resolution) ? options.resolution : undefined,
            isNonEmptyString(options.aspectRatio) ? options.aspectRatio : undefined,
        )
        if (!/^\d+x\d+$/.test(size)) {
            throw new Error(`TENCENT_IMAGE_OPTION_VALUE_UNSUPPORTED: size=${size}`)
        }
        const [width, height] = size.split('x').map((part) => Number.parseInt(part, 10))
        if (width % IMAGE_PIXEL_STEP !== 0 || height % IMAGE_PIXEL_STEP !== 0) {
            throw new Error(`TENCENT_IMAGE_OPTION_VALUE_UNSUPPORTED: 尺寸必须被 ${IMAGE_PIXEL_STEP} 整除 (${size})`)
        }
        const totalPixels = width * height
        if (totalPixels < IMAGE_MIN_TOTAL_PIXELS || totalPixels > IMAGE_MAX_TOTAL_PIXELS) {
            throw new Error(`TENCENT_IMAGE_OPTION_VALUE_UNSUPPORTED: 总像素超出范围 (${size})`)
        }

        const boundedRefs = referenceImages.filter(isNonEmptyString).slice(0, spec.maxReferenceImages)
        const referenceUrls = await Promise.all(boundedRefs.map((ref) => resolveTencentResourceUrl(ref)))
        _ulogInfo(`${logPrefix} 提交任务 model=${modelId} size=${size} refs=${referenceUrls.length}`)

        const payload: Record<string, unknown> = {
            SubAppId: credentials.subAppId,
            ModelName: spec.modelName,
            ModelVersion: isNonEmptyString(options.modelVersion) ? String(options.modelVersion).trim() : spec.modelVersion,
            InputRegion: 'Mainland',
            TasksPriority: 10,
            GenerationMode: 'Professional',
            Prompt: prompt,
            EnhancePrompt: 'Enabled',
            ...(referenceUrls.length > 0
                ? { FileInfos: referenceUrls.map((url) => ({ Type: 'Url', Url: url })) }
                : {}),
            ...(spec.modelName === 'OG' ? { ExtInfo: JSON.stringify({ AdditionalParameters: { size } }) } : {}),
            OutputConfig: {
                StorageMode: 'Temporary',
                Resolution: size,
                AspectRatio: rawAspectRatio,
                PersonGeneration: 'AllowAdult',
                InputComplianceCheck: 'Enabled',
                OutputComplianceCheck: 'Enabled',
                OutputImageCount: 1,
            },
        }

        try {
            const response = await callTencentVod({
                action: 'CreateAigcImageTask',
                payload,
                credentials,
                timeoutMs: 60_000,
            })
            const taskId = typeof response.TaskId === 'string' ? response.TaskId : ''
            if (!taskId) {
                _ulogError(`${logPrefix} 响应中缺少 TaskId:`, response)
                throw new Error('TENCENT_IMAGE_SUBMIT_FAILED: 未返回 TaskId')
            }
            _ulogInfo(`${logPrefix} 任务已提交 TaskId=${taskId}`)
            return {
                success: true,
                async: true,
                requestId: taskId,
                externalId: `TENCENT:IMAGE:${taskId}`,
            }
        } catch (error: unknown) {
            _ulogError(`${logPrefix} 提交失败:`, error)
            throw error
        }
    }
}
