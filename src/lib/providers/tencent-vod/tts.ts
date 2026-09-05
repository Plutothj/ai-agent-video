import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
/**
 * 腾讯云台词配音（异步语音合成 TextToSpeechAsync）
 *
 * 接口：POST vod.tencentcloudapi.com / TextToSpeechAsync（2018-07-17）
 * 提交返回 TaskId，任务完成后通过 DescribeTaskDetail 轮询取产物音频 URL。
 * 参考：https://cloud.tencent.com/document/product/266/137247
 *
 * 音色为账号级 VoiceId（控制台音色列表或 MPS DescribeVoices 获取，ttv-voice-* 前缀），
 * 不支持参考音频克隆。
 */

import { callTencentVod, resolveTencentCloudCredentials, TencentCloudError } from '@/lib/tencent-cloud/client'
import type { TencentCloudCredentials } from '@/lib/tencent-cloud/client'

export const TENCENT_TTS_DEFAULT_MODEL = 'minimax-speech-2.8-hd'
const TTS_POLL_INTERVAL_MS = 3_000
const TTS_POLL_MAX_WAIT_MS = 180_000

export interface TencentTTSInput {
  text: string
  voiceId: string
  modelId?: string
  speed?: number
  vol?: number
  pitch?: number
  emotion?: string
  sampleRate?: number
  language?: 'zh' | 'en' | 'auto'
}

export interface TencentTTSResult {
  success: boolean
  audioData?: Buffer
  audioDuration?: number
  requestId?: string
  error?: string
}

interface TtsTaskOutput {
  Status?: string
  ErrCode?: number | string
  Message?: string
  Output?: {
    FileInfos?: Array<{ FileUrl?: string; UsageType?: string }>
    AudioUrl?: string
    AudioInfos?: Array<{ Url?: string; FileUrl?: string }>
  }
}

function readErrCode(value: number | string | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function extractAudioUrl(task: TtsTaskOutput): string | null {
  const fileInfos = task.Output?.FileInfos || []
  for (const fileInfo of fileInfos) {
    const url = typeof fileInfo.FileUrl === 'string' ? fileInfo.FileUrl.trim() : ''
    if (url) return url
  }
  const audioInfos = task.Output?.AudioInfos || []
  for (const audioInfo of audioInfos) {
    const url = (audioInfo.Url || audioInfo.FileUrl || '').trim()
    if (url) return url
  }
  const directUrl = typeof task.Output?.AudioUrl === 'string' ? task.Output.AudioUrl.trim() : ''
  return directUrl || null
}

export function getWavDurationMs(buffer: Buffer): number {
  try {
    if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') {
      return 0
    }
    const byteRate = buffer.readUInt32LE(28)
    let offset = 12
    while (offset < buffer.length - 8) {
      const chunkId = buffer.slice(offset, offset + 4).toString('ascii')
      const chunkSize = buffer.readUInt32LE(offset + 4)
      if (chunkId === 'data') {
        return byteRate > 0 ? Math.round((chunkSize / byteRate) * 1000) : 0
      }
      offset += 8 + chunkSize
    }
    return 0
  } catch {
    return 0
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 合成台词配音：提交 TextToSpeechAsync 并轮询直到完成，返回 WAV 音频 Buffer。
 */
export async function synthesizeWithTencentTTS(
  input: TencentTTSInput,
  providerApiKey?: string,
): Promise<TencentTTSResult> {
  const logPrefix = '[Tencent TTS]'
  const text = (input.text || '').trim()
  if (!text) {
    return { success: false, error: 'TENCENT_TTS_TEXT_EMPTY' }
  }
  const voiceId = (input.voiceId || '').trim()
  if (!voiceId) {
    return { success: false, error: 'TENCENT_TTS_VOICE_ID_MISSING' }
  }

  let credentials: TencentCloudCredentials
  try {
    credentials = resolveTencentCloudCredentials(providerApiKey)
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }

  const extParam: Record<string, unknown> = {
    model: input.modelId?.trim() || TENCENT_TTS_DEFAULT_MODEL,
    audio_setting: {
      speed: typeof input.speed === 'number' ? Math.min(2, Math.max(0.5, input.speed)) : 1.0,
      vol: typeof input.vol === 'number' ? Math.min(10, Math.max(0.1, input.vol)) : 1.0,
      pitch: typeof input.pitch === 'number' ? Math.min(12, Math.max(-12, Math.round(input.pitch))) : 0,
      ...(input.emotion?.trim() ? { emotion: input.emotion.trim() } : {}),
      sample_rate: input.sampleRate ?? 32000,
      format: 'wav',
    },
  }

  // 1. 提交异步任务
  let taskId: string
  try {
    const response = await callTencentVod({
      action: 'TextToSpeechAsync',
      payload: {
        SubAppId: credentials.subAppId,
        Text: text,
        VoiceId: voiceId,
        LanguageBoost: input.language ?? 'auto',
        ExtParam: JSON.stringify(extParam),
      },
      credentials,
      timeoutMs: 30_000,
    })
    taskId = typeof response.TaskId === 'string' ? response.TaskId : ''
    if (!taskId) {
      _ulogError(`${logPrefix} 响应中缺少 TaskId:`, response)
      return { success: false, error: 'TENCENT_TTS_SUBMIT_FAILED: 未返回 TaskId' }
    }
    _ulogInfo(`${logPrefix} 任务已提交 TaskId=${taskId}`)
  } catch (error: unknown) {
    _ulogError(`${logPrefix} 提交失败:`, error)
    return {
      success: false,
      error: error instanceof TencentCloudError ? error.message : `TENCENT_TTS_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // 2. 轮询 DescribeTaskDetail 直到终态
  const deadline = Date.now() + TTS_POLL_MAX_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(TTS_POLL_INTERVAL_MS)
    try {
      const detail = await callTencentVod({
        action: 'DescribeTaskDetail',
        payload: {
          SubAppId: credentials.subAppId,
          TaskId: taskId,
        },
        credentials,
      }) as TtsTaskOutput

      const status = (typeof detail.Status === 'string' ? detail.Status : '').trim().toUpperCase()
      const errCode = readErrCode(detail.ErrCode)

      if (status === 'FINISH' && errCode === 0) {
        const audioUrl = extractAudioUrl(detail)
        if (!audioUrl) {
          return { success: false, error: 'TENCENT_TTS_COMPLETED_WITHOUT_AUDIO', requestId: taskId }
        }
        const audioResponse = await fetch(audioUrl)
        if (!audioResponse.ok) {
          return { success: false, error: `TENCENT_TTS_DOWNLOAD_FAILED: ${audioResponse.status}`, requestId: taskId }
        }
        const audioData = Buffer.from(await audioResponse.arrayBuffer())
        _ulogInfo(`${logPrefix} 合成完成 TaskId=${taskId} bytes=${audioData.length}`)
        return {
          success: true,
          audioData,
          audioDuration: getWavDurationMs(audioData) || undefined,
          requestId: taskId,
        }
      }

      if (status === 'ABORTED' || status === 'FAIL' || (status === 'FINISH' && errCode !== 0)) {
        const message = detail.Message || `任务失败 (${status}, ErrCode=${String(detail.ErrCode)})`
        _ulogError(`${logPrefix} TaskId=${taskId} 失败: ${message}`)
        return { success: false, error: `TENCENT_TTS_FAILED: ${message}`, requestId: taskId }
      }
    } catch (error: unknown) {
      _ulogError(`${logPrefix} 轮询异常 TaskId=${taskId}:`, error)
      // 轮询单次失败不终止，继续等待下一轮
    }
  }

  return { success: false, error: 'TENCENT_TTS_POLL_TIMEOUT', requestId: taskId }
}
