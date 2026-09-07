import { getProviderConfig } from '@/lib/api-config'
import { callTencentVod, resolveTencentCloudCredentials } from '@/lib/tencent-cloud/client'
import { resolveTencentResourceUrl } from '@/lib/generators/tencent-vod'
import type { LipSyncParams, LipSyncResult, LipSyncSubmitContext } from '@/lib/lipsync/types'

/**
 * 腾讯云 VOD Kling 对口型（lip_sync）。
 *
 * 通过 CreateAigcVideoTask + SceneType=lip_sync，把「已有视频 + TTS 配音音频」交给 Kling，
 * 让视频人物嘴型与音频对齐，输出一段对口型的新视频。无需独立的唇形同步服务商（FAL/Vidu/Bailian）。
 *
 * 参考：AigcVideoTaskInputFileInfo
 *   - Category: Video  + ReferenceType=base  → 待编辑（待对口型）视频
 *   - Category: Audio                        → 驱动口型的音频
 *   - Type: Url（腾讯云仅接受公网可访问 URL）
 */

const KING_LIP_SYNC_MODEL_NAME = 'Kling'
const KING_LIP_SYNC_DEFAULT_MODEL_VERSION = '3.0'

/** 从 modelId 提取 Kling 版本号（形如 "kling-3.0" → "3.0"），失败回落默认版本。 */
function resolveKlingModelVersion(modelId: string): string {
  const trimmed = modelId.trim()
  const match = /(?:^|[-_])(\d+(?:\.\d+)*)(?:[-_]|$)/.exec(trimmed)
  if (match && match[1]) {
    return match[1]
  }
  return KING_LIP_SYNC_DEFAULT_MODEL_VERSION
}

export async function submitTencentVodLipSync(
  params: LipSyncParams,
  context: LipSyncSubmitContext,
): Promise<LipSyncResult> {
  const { apiKey } = await getProviderConfig(context.userId, 'tencent-vod')
  const credentials = resolveTencentCloudCredentials(apiKey)

  // 视频与音频都必须是公网可访问的 URL（腾讯云服务器拉取）
  const [videoUrl, audioUrl] = await Promise.all([
    resolveTencentResourceUrl(params.videoUrl),
    resolveTencentResourceUrl(params.audioUrl),
  ])

  const modelVersion = resolveKlingModelVersion(context.modelId)

  const payload: Record<string, unknown> = {
    SubAppId: credentials.subAppId,
    ModelName: KING_LIP_SYNC_MODEL_NAME,
    ModelVersion: modelVersion,
    SceneType: 'lip_sync',
    FileInfos: [
      // 待对口型视频（ReferenceType=base 表示「待编辑视频」）
      { Type: 'Url', Category: 'Video', Url: videoUrl, ReferenceType: 'base' },
      // 驱动口型的音频
      { Type: 'Url', Category: 'Audio', Url: audioUrl },
    ],
    OutputConfig: {
      StorageMode: 'Temporary',
    },
  }

  const response = await callTencentVod({
    action: 'CreateAigcVideoTask',
    payload,
    credentials,
    timeoutMs: 60_000,
  })

  const taskId = typeof response.TaskId === 'string' ? response.TaskId : ''
  if (!taskId) {
    throw new Error('TENCENT_LIPSYNC_SUBMIT_FAILED: 未返回 TaskId')
  }

  return {
    requestId: taskId,
    externalId: `TENCENT:VIDEO:${taskId}`,
    async: true,
  }
}
