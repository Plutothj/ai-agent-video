import { safeParseJson, safeParseJsonArray } from '@/lib/json-repair'
import { prisma } from '@/lib/prisma'
import type { StoryboardPanel } from '@/lib/storyboard-phases'

export type JsonRecord = Record<string, unknown>

export type ClipPanelsResult = {
  clipId: string
  clipIndex: number
  finalPanels: StoryboardPanel[]
}

export type PersistedStoryboard = {
  storyboardId: string
  clipId: string
  panels: Array<{
    id: string
    panelIndex: number
    description: string | null
    srtSegment: string | null
    characters: string | null
    props: string | null
  }>
}

export function parseEffort(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | null {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') return value
  return null
}

export function parseTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7
  return Math.max(0, Math.min(2, value))
}

export function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.floor(value)
  return n >= 0 ? n : null
}

/**
 * 台词字数 → 单镜时长重算。
 *
 * 背景：panel.duration 由 Phase 3 LLM 拍脑袋给定，而 source_text（台词，用于配音/唇形同步）
 * 又是独立生成的，两者没有绑定。LLM 常忽略「台词要短」的约束，产出 40~100+ 字台词却只给 4~5s，
 * 导致唇形同步把长音频硬塞进短视频，时长不够、嘴型对不上。
 *
 * 这里在持久化时按台词字数刚性重算时长，保证「画面时长 >= 配音所需时长」：
 *   duration = clamp(max(LLM 给定值, ceil(台词字数 / 语速)), 最低下限, 上限)
 *
 * 语速取 4 字/秒（文言文/口语含标点停顿的保守值，为口型与呼吸留余量）；
 * 最低下限 4s 对齐视频模型最短档位（Wan/Kling 等 minDuration=2，但 4s 更接近分镜规划基准）；
 * 上限 15s 对齐腾讯 VOD 主流模型（Kling/VS 系列）的最大时长，避免超长台词算出模型不支持的时长。
 * 台词超过 15s 属极端长镜，应由台词截短约束处理，这里先封顶防止 lip-sync/视频生成崩坏。
 */
export const SPEECH_CHARS_PER_SECOND = 4
export const MIN_PANEL_DURATION_SECONDS = 4
export const MAX_PANEL_DURATION_SECONDS = 15

/** 统计台词有效字数：仅计中文字符与字母数字，忽略标点、空白、空格、引号、省略号等。 */
export function countSpeechChars(text: string | null | undefined): number {
  if (!text) return 0
  // 匹配中日韩字符 + 拉丁字母 + 数字；剔除标点、空白、括号、引号、省略号等非发音字符
  const matches = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/g)
  return matches ? matches.length : 0
}

export function computePanelDurationBySpeech(
  sourceText: string | null | undefined,
  llmDuration: number | null | undefined,
): number {
  const speechChars = countSpeechChars(sourceText)
  if (speechChars === 0) {
    // 无台词镜头：保留 LLM 给定值，无给定则回落到最低下限
    return typeof llmDuration === 'number' && Number.isFinite(llmDuration) && llmDuration > 0
      ? Math.min(Math.round(llmDuration), MAX_PANEL_DURATION_SECONDS)
      : MIN_PANEL_DURATION_SECONDS
  }
  const speechSeconds = Math.ceil(speechChars / SPEECH_CHARS_PER_SECOND)
  const base = typeof llmDuration === 'number' && Number.isFinite(llmDuration) && llmDuration > 0
    ? Math.round(llmDuration)
    : MIN_PANEL_DURATION_SECONDS
  const duration = Math.max(base, speechSeconds, MIN_PANEL_DURATION_SECONDS)
  return Math.min(duration, MAX_PANEL_DURATION_SECONDS)
}

function parsePanelCharacters(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
  } catch {
    return []
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean)
  } catch {
    return []
  }
}

export function parseVoiceLinesJson(responseText: string): JsonRecord[] {
  const rows = safeParseJsonArray(responseText)
  if (rows.length === 0) {
    const raw = safeParseJson(responseText)
    if (Array.isArray(raw) && raw.length === 0) {
      return []
    }
    throw new Error('voice_analyze: invalid payload')
  }
  return rows as JsonRecord[]
}

export function asJsonRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null
}

export function buildStoryboardJson(storyboards: PersistedStoryboard[]) {
  const rows: Array<{
    storyboardId: string
    panelIndex: number
    text_segment: string
    description: string
    characters: string[]
    props: string[]
  }> = []

  for (const storyboard of storyboards) {
    for (const panel of storyboard.panels) {
      rows.push({
        storyboardId: storyboard.storyboardId,
        panelIndex: panel.panelIndex,
        text_segment: panel.srtSegment || '',
        description: panel.description || '',
        characters: parsePanelCharacters(panel.characters),
        props: parseStringArray(panel.props),
      })
    }
  }

  if (rows.length === 0) return '无分镜数据'
  return JSON.stringify(rows, null, 2)
}

export function buildStoryboardJsonFromClipPanels(clipPanels: ClipPanelsResult[]) {
  const rows: Array<{
    storyboardId: string
    panelIndex: number
    text_segment: string
    description: string
    characters: string[]
    props: string[]
  }> = []

  for (const clipEntry of clipPanels) {
    for (let index = 0; index < clipEntry.finalPanels.length; index += 1) {
      const panel = clipEntry.finalPanels[index]
      rows.push({
        storyboardId: clipEntry.clipId,
        panelIndex: index,
        text_segment: panel.source_text || '',
        description: panel.description || '',
        characters: Array.isArray(panel.characters) ? panel.characters.filter(Boolean) : [],
        props: Array.isArray(panel.props) ? panel.props.filter(Boolean) : [],
      })
    }
  }

  if (rows.length === 0) return '无分镜数据'
  return JSON.stringify(rows, null, 2)
}

export async function persistStoryboardsAndPanels(params: {
  episodeId: string
  clipPanels: ClipPanelsResult[]
}) {
  const { episodeId, clipPanels } = params
  type PanelRow = {
    id: string
    panelIndex: number
    description: string | null
    srtSegment: string | null
    characters: string | null
    props: string | null
  }
  return await prisma.$transaction(async (tx) => {
    const persisted: PersistedStoryboard[] = []
    for (const clipEntry of clipPanels) {
      const storyboard = await tx.novelPromotionStoryboard.upsert({
        where: { clipId: clipEntry.clipId },
        create: {
          clipId: clipEntry.clipId,
          episodeId,
          panelCount: clipEntry.finalPanels.length,
        },
        update: {
          panelCount: clipEntry.finalPanels.length,
          episodeId,
          lastError: null,
        },
        select: { id: true, clipId: true },
      })

      await tx.novelPromotionPanel.deleteMany({
        where: { storyboardId: storyboard.id },
      })

      const panelModel = tx.novelPromotionPanel as unknown as {
        create: (args: {
          data: Record<string, unknown>
          select: {
            id: true
            panelIndex: true
            description: true
            srtSegment: true
            characters: true
            props: true
          }
        }) => Promise<PanelRow>
      }
      const persistedPanels: PersistedStoryboard['panels'] = []
      for (let i = 0; i < clipEntry.finalPanels.length; i += 1) {
        const panel = clipEntry.finalPanels[i]
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panel.description || null,
            videoPrompt: panel.video_prompt || null,
            location: panel.location || null,
            characters: panel.characters ? JSON.stringify(panel.characters) : null,
            props: panel.props ? JSON.stringify(panel.props) : null,
            srtSegment: panel.source_text || null,
            photographyRules: panel.photographyPlan ? JSON.stringify(panel.photographyPlan) : null,
            actingNotes: panel.actingNotes ? JSON.stringify(panel.actingNotes) : null,
            duration: computePanelDurationBySpeech(panel.source_text, panel.duration),
          },
          select: {
            id: true,
            panelIndex: true,
            description: true,
            srtSegment: true,
            characters: true,
            props: true,
          },
        })
        persistedPanels.push(created)
      }

      persisted.push({
        storyboardId: storyboard.id,
        clipId: storyboard.clipId,
        panels: persistedPanels,
      })
    }
    return persisted
  }, { timeout: 30000 })
}

export async function persistStoryboardOutputs(params: {
  episodeId: string
  clipPanels: ClipPanelsResult[]
  voiceLineRows: JsonRecord[] | null
}) {
  const persistedStoryboards = await prisma.$transaction(async (tx) => {
    const persisted: PersistedStoryboard[] = []
    const panelIdByStoryboardRef = new Map<string, string>()
    const storyboardIdByRef = new Map<string, string>()

    for (const clipEntry of params.clipPanels) {
      const storyboard = await tx.novelPromotionStoryboard.upsert({
        where: { clipId: clipEntry.clipId },
        create: {
          clipId: clipEntry.clipId,
          episodeId: params.episodeId,
          panelCount: clipEntry.finalPanels.length,
        },
        update: {
          panelCount: clipEntry.finalPanels.length,
          episodeId: params.episodeId,
          lastError: null,
        },
        select: { id: true, clipId: true },
      })
      storyboardIdByRef.set(storyboard.id, storyboard.id)
      storyboardIdByRef.set(clipEntry.clipId, storyboard.id)

      await tx.novelPromotionPanel.deleteMany({
        where: { storyboardId: storyboard.id },
      })

      const panelModel = tx.novelPromotionPanel as unknown as {
        create: (args: {
          data: Record<string, unknown>
          select: {
            id: true
            panelIndex: true
            description: true
            srtSegment: true
            characters: true
            props: true
          }
        }) => Promise<{
          id: string
          panelIndex: number
          description: string | null
          srtSegment: string | null
          characters: string | null
          props: string | null
        }>
      }
      const persistedPanels: PersistedStoryboard['panels'] = []
      for (let i = 0; i < clipEntry.finalPanels.length; i += 1) {
        const panel = clipEntry.finalPanels[i]
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panel.description || null,
            videoPrompt: panel.video_prompt || null,
            location: panel.location || null,
            characters: panel.characters ? JSON.stringify(panel.characters) : null,
            props: panel.props ? JSON.stringify(panel.props) : null,
            srtSegment: panel.source_text || null,
            photographyRules: panel.photographyPlan ? JSON.stringify(panel.photographyPlan) : null,
            actingNotes: panel.actingNotes ? JSON.stringify(panel.actingNotes) : null,
            duration: computePanelDurationBySpeech(panel.source_text, panel.duration),
          },
          select: {
            id: true,
            panelIndex: true,
            description: true,
            srtSegment: true,
            characters: true,
            props: true,
          },
        })
        panelIdByStoryboardRef.set(`${storyboard.id}:${created.panelIndex}`, created.id)
        panelIdByStoryboardRef.set(`${clipEntry.clipId}:${created.panelIndex}`, created.id)
        persistedPanels.push(created)
      }

      persisted.push({
        storyboardId: storyboard.id,
        clipId: storyboard.clipId,
        panels: persistedPanels,
      })
    }

    const voiceLineModel = tx.novelPromotionVoiceLine as unknown as {
      upsert?: (args: unknown) => Promise<{ id: string }>
      create: (args: unknown) => Promise<{ id: string }>
      deleteMany: (args: unknown) => Promise<unknown>
    }
    const createdVoiceLines: Array<{ id: string }> = []
    const voiceLineRows = params.voiceLineRows ?? []

    for (let i = 0; i < voiceLineRows.length; i += 1) {
      const row = voiceLineRows[i] || {}
      const matchedPanel = asJsonRecord(row.matchedPanel)
      const matchedStoryboardRef =
        matchedPanel && typeof matchedPanel.storyboardId === 'string'
          ? matchedPanel.storyboardId.trim()
          : null
      const matchedPanelIndex = matchedPanel ? toPositiveInt(matchedPanel.panelIndex) : null
      let matchedPanelId: string | null = null
      let matchedStoryboardId: string | null = null
      if (matchedPanel !== null) {
        if (!matchedStoryboardRef || matchedPanelIndex === null) {
          throw new Error(`voice line ${i + 1} has invalid matchedPanel reference`)
        }
        matchedStoryboardId = storyboardIdByRef.get(matchedStoryboardRef) || null
        if (!matchedStoryboardId) {
          throw new Error(`voice line ${i + 1} references non-existent storyboard ${matchedStoryboardRef}`)
        }
        const panelKey = `${matchedStoryboardRef}:${matchedPanelIndex}`
        const resolvedPanelId = panelIdByStoryboardRef.get(panelKey)
        if (!resolvedPanelId) {
          throw new Error(`voice line ${i + 1} references non-existent panel ${panelKey}`)
        }
        matchedPanelId = resolvedPanelId
      }

      if (typeof row.emotionStrength !== 'number' || !Number.isFinite(row.emotionStrength)) {
        throw new Error(`voice line ${i + 1} is missing valid emotionStrength`)
      }
      const emotionStrength = Math.min(1, Math.max(0.1, row.emotionStrength))

      if (typeof row.lineIndex !== 'number' || !Number.isFinite(row.lineIndex)) {
        throw new Error(`voice line ${i + 1} is missing valid lineIndex`)
      }
      const lineIndex = Math.floor(row.lineIndex)
      if (lineIndex <= 0) {
        throw new Error(`voice line ${i + 1} has invalid lineIndex`)
      }
      if (typeof row.speaker !== 'string' || !row.speaker.trim()) {
        throw new Error(`voice line ${i + 1} is missing valid speaker`)
      }
      if (typeof row.content !== 'string' || !row.content.trim()) {
        throw new Error(`voice line ${i + 1} is missing valid content`)
      }

      const upsertArgs = {
        where: {
          episodeId_lineIndex: {
            episodeId: params.episodeId,
            lineIndex,
          },
        },
        create: {
          episodeId: params.episodeId,
          lineIndex,
          speaker: row.speaker.trim(),
          content: row.content,
          emotionStrength,
          matchedPanelId,
          matchedStoryboardId,
          matchedPanelIndex,
        },
        update: {
          speaker: row.speaker.trim(),
          content: row.content,
          emotionStrength,
          matchedPanelId,
          matchedStoryboardId,
          matchedPanelIndex,
        },
        select: { id: true },
      }
      const createdRow = typeof voiceLineModel.upsert === 'function'
        ? await voiceLineModel.upsert(upsertArgs)
        : (
          process.env.NODE_ENV === 'test'
            ? await voiceLineModel.create({
              data: upsertArgs.create,
              select: { id: true },
            })
            : (() => { throw new Error('novelPromotionVoiceLine.upsert unavailable') })()
        )
      createdVoiceLines.push(createdRow)
    }

    const nextLineIndexes = voiceLineRows
      .map((row) => (typeof row.lineIndex === 'number' && Number.isFinite(row.lineIndex) ? Math.floor(row.lineIndex) : -1))
      .filter((value) => value > 0)
    if (nextLineIndexes.length === 0) {
      await voiceLineModel.deleteMany({
        where: {
          episodeId: params.episodeId,
        },
      })
    } else {
      await voiceLineModel.deleteMany({
        where: {
          episodeId: params.episodeId,
          lineIndex: {
            notIn: nextLineIndexes,
          },
        },
      })
    }

    return {
      persistedStoryboards: persisted,
      createdVoiceLines,
    }
  }, { timeout: 30000 })

  return {
    persistedStoryboards: persistedStoryboards.persistedStoryboards,
    voiceLineCount: persistedStoryboards.createdVoiceLines.length,
  }
}
