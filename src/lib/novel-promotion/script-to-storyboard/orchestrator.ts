import { safeParseJsonArray } from '@/lib/json-repair'
import { buildCharactersIntroduction } from '@/lib/constants'
import { normalizeAnyError } from '@/lib/errors/normalize'
import { createScopedLogger } from '@/lib/logging/core'
import { mapWithConcurrency } from '@/lib/async/map-with-concurrency'
import {
  assertPanelNumberCoverage,
  chunkByPanelCount,
  mergePhase3Overrides,
  PHASE1_MAX_OUTPUT_TOKENS,
  PHASE_STEP_MAX_OUTPUT_TOKENS,
  type ActingDirection,
  type CharacterAsset,
  type ClipCharacterRef,
  type LocationAsset,
  type PropAsset,
  type PhotographyRule,
  type StoryboardPanel,
  formatClipId,
  getFilteredAppearanceList,
  getFilteredFullDescription,
  getFilteredLocationsDescription,
} from '@/lib/storyboard-phases'
import {
  buildPromptAssetContext,
  compileAssetPromptFragments,
} from '@/lib/assets/services/asset-prompt-context'
import {
  DEFAULT_ANALYSIS_WORKFLOW_CONCURRENCY,
  normalizeWorkflowConcurrencyValue,
} from '@/lib/workflow-concurrency'

type JsonRecord = Record<string, unknown>
const orchestratorLogger = createScopedLogger({ module: 'worker.orchestrator.script_to_storyboard' })

export type ScriptToStoryboardStepMeta = {
  stepId: string
  stepAttempt?: number
  stepTitle: string
  stepIndex: number
  stepTotal: number
  dependsOn?: string[]
  groupId?: string
  parallelKey?: string
  retryable?: boolean
  blockedBy?: string[]
}

export type ScriptToStoryboardStepOutput = {
  text: string
  reasoning: string
}

type ClipInput = {
  id: string
  content: string | null
  characters: string | null
  location: string | null
  props?: string | null
  screenplay: string | null
}

export type ScriptToStoryboardPromptTemplates = {
  phase1PlanTemplate: string
  phase2CinematographyTemplate: string
  phase2ActingTemplate: string
  phase3DetailTemplate: string
}

export type ClipStoryboardPanels = {
  clipId: string
  clipIndex: number
  finalPanels: StoryboardPanel[]
}

export type ScriptToStoryboardOrchestratorInput = {
  concurrency?: number
  locale?: 'zh' | 'en'
  clips: ClipInput[]
  novelPromotionData: {
    characters: CharacterAsset[]
    locations: LocationAsset[]
    props?: PropAsset[]
  }
  promptTemplates: ScriptToStoryboardPromptTemplates
  runStep: (
    meta: ScriptToStoryboardStepMeta,
    prompt: string,
    action: string,
    maxOutputTokens: number,
  ) => Promise<ScriptToStoryboardStepOutput>
  /**
   * 每个步骤解析成功后立即回调（用于把中间产物按步骤持久化为 GraphArtifact）。
   * 产物必须逐步落库：否则任一步骤失败会导致整个 run 没有任何产物，后续步骤级重试
   * 会因缺少 storyboard.clip.phase1 等依赖产物而必然失败。
   */
  onStepParsed?: (params: { stepKey: string, parsed: unknown }) => Promise<void>
}

export type ScriptToStoryboardOrchestratorResult = {
  clipPanels: ClipStoryboardPanels[]
  phase1PanelsByClipId: Record<string, StoryboardPanel[]>
  phase2CinematographyByClipId: Record<string, PhotographyRule[]>
  phase2ActingByClipId: Record<string, ActingDirection[]>
  phase3PanelsByClipId: Record<string, StoryboardPanel[]>
  summary: {
    clipCount: number
    totalPanelCount: number
    totalStepCount: number
  }
}


export class JsonParseError extends Error {
  rawText: string
  constructor(message: string, rawText: string) {
    super(message)
    this.name = 'JsonParseError'
    this.rawText = rawText
  }
}

function parseJsonArray<T extends JsonRecord>(responseText: string, label: string): T[] {
  const rows = safeParseJsonArray(responseText)
  if (rows.length === 0) {
    throw new JsonParseError(`${label}: empty result`, responseText)
  }
  return rows as T[]
}

function panelNumberKey(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  return ''
}

/**
 * 校验行业规则（摄影/表演）覆盖了 phase1 的全部面板编号。
 * 一旦 LLM 输出缺漏或拼错编号，必须在 parse 阶段地内抛错走重试，
 * 而不是等到最终 merge 阶段抛出不可重试的硬错误（否则整个 run 直接失败）。
 */
export function assertRulePanelCoverage<T extends { panel_number?: unknown }>(
  rows: T[],
  expected: StoryboardPanel[],
  label: string,
): void {
  assertPanelNumberCoverage(rows, expected, label, 'rules')
}

/**
 * 校验 phase3 输出的面板集合与 phase1 完全一致（缺失或多余都算失败）。
 * phase3 是最终面板数据，LLM 擅自增删面板会导致后续 merge/视频流程错位。
 */
export function assertPhase3PanelSet<T extends { panel_number?: unknown }>(
  rows: T[],
  expected: StoryboardPanel[],
  label: string,
): void {
  const expectedNums = new Set(expected.map((p) => panelNumberKey(p.panel_number)))
  const actualNums = new Set(rows.map((r) => panelNumberKey(r.panel_number)))
  const missing = [...expectedNums].filter((n) => !actualNums.has(n))
  const extra = [...actualNums].filter((n) => !expectedNums.has(n))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} panel set mismatch: missing=[${missing.join(',')}] extra=[${extra.join(',')}]` +
      ` (expected ${expectedNums.size} panels, got ${actualNums.size})`,
    )
  }
}


function parseClipCharacters(raw: string | null): ClipCharacterRef[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('characters field must be JSON array')
    }
    return parsed as ClipCharacterRef[]
  } catch (error) {
    throw new Error(`Invalid clip characters JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseClipProps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('props field must be JSON array')
    }
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  } catch (error) {
    throw new Error(`Invalid clip props JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseScreenplay(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid clip screenplay JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function withStepMeta(
  stepId: string,
  stepTitle: string,
  stepIndex: number,
  stepTotal: number,
  extra?: Pick<ScriptToStoryboardStepMeta, 'dependsOn' | 'groupId' | 'parallelKey' | 'retryable' | 'blockedBy'>,
): ScriptToStoryboardStepMeta {
  return {
    stepId,
    stepTitle,
    stepIndex,
    stepTotal,
    ...extra,
  }
}

function mergePanelsWithRules(params: {
  finalPanels: StoryboardPanel[]
  photographyRules: PhotographyRule[]
  actingDirections: ActingDirection[]
}) {
  const { finalPanels, photographyRules, actingDirections } = params
  return finalPanels.map((panel, index) => {
    const rules = photographyRules.find((rule) => rule.panel_number === panel.panel_number)
    if (!rules) {
      throw new Error(
        `Missing photography rule for panel_number=${String(panel.panel_number)} at index=${index}` +
        ` (photography rules: ${photographyRules.length}, final panels: ${finalPanels.length})`,
      )
    }
    const acting = actingDirections.find((item) => item.panel_number === panel.panel_number)
    if (!acting) {
      throw new Error(`Missing acting direction for panel_number=${String(panel.panel_number)} at index=${index}`)
    }

    return {
      ...panel,
      photographyPlan: {
        composition: rules.composition,
        lighting: rules.lighting,
        colorPalette: rules.color_palette,
        atmosphere: rules.atmosphere,
        technicalNotes: rules.technical_notes,
      },
      actingNotes: acting.characters,
    }
  })
}

const MAX_STEP_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 10_000

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function computeRetryDelayMs(attempt: number) {
  const base = Math.min(1_000 * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS)
  const jitter = Math.floor(Math.random() * 300)
  return base + jitter
}

function shouldRetryStepError(error: unknown, message: string, retryable: boolean) {
  if (error instanceof JsonParseError) return true
  if (retryable) return true
  const lowerMessage = message.toLowerCase()
  if (lowerMessage.includes('ark responses 调用失败')) return false
  if (lowerMessage.includes('invalidparameter')) return false
  if (lowerMessage.includes('unknown field')) return false
  // 截断重试必然再截断，必须快速失败并放大 maxOutputTokens
  if (lowerMessage.includes('llm_output_truncated')) return false
  return lowerMessage.includes('unexpected token')
    || lowerMessage.includes('unexpected end of json input')
    || lowerMessage.includes('json format invalid')
    || lowerMessage.includes('invalid json output')
    || lowerMessage.includes('parse')
}

async function runStepWithRetry<T>(
  runStep: ScriptToStoryboardOrchestratorInput['runStep'],
  baseMeta: ScriptToStoryboardStepMeta,
  prompt: string,
  action: string,
  maxOutputTokens: number,
  parse: (text: string) => T,
  onStepParsed?: ScriptToStoryboardOrchestratorInput['onStepParsed'],
): Promise<{ output: ScriptToStoryboardStepOutput; parsed: T }> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    const meta = attempt === 1
      ? baseMeta
      : {
        ...baseMeta,
        stepId: baseMeta.stepId,
        stepAttempt: attempt,
        stepTitle: baseMeta.stepTitle,
      }
    try {
      const output = await runStep(meta, prompt, action, maxOutputTokens)
      const parsed = parse(output.text)
      if (onStepParsed) {
        await onStepParsed({ stepKey: baseMeta.stepId, parsed })
      }
      return { output, parsed }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const normalizedError = normalizeAnyError(error, { context: 'worker' })
      const shouldRetry = attempt < MAX_STEP_ATTEMPTS
        && shouldRetryStepError(error, normalizedError.message, normalizedError.retryable)

      orchestratorLogger.error({
        action: 'orchestrator.step.retry',
        message: shouldRetry ? 'step failed, retrying' : 'step failed, no more retry',
        errorCode: normalizedError.code,
        retryable: normalizedError.retryable,
        details: {
          stepId: baseMeta.stepId,
          action,
          attempt,
          maxAttempts: MAX_STEP_ATTEMPTS,
        },
        error: {
          name: lastError.name,
          message: lastError.message,
          stack: lastError.stack,
        },
      })

      if (!shouldRetry) {
        break
      }
      const retryDelayMs = computeRetryDelayMs(attempt)
      await wait(retryDelayMs)
    }
  }
  throw lastError!
}

export async function runScriptToStoryboardOrchestrator(
  input: ScriptToStoryboardOrchestratorInput,
): Promise<ScriptToStoryboardOrchestratorResult> {
  const { clips, novelPromotionData, promptTemplates, runStep, onStepParsed, concurrency: rawConcurrency } = input
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('No clips found')
  }
  const concurrency = normalizeWorkflowConcurrencyValue(
    rawConcurrency,
    DEFAULT_ANALYSIS_WORKFLOW_CONCURRENCY,
  )

  const totalStepCount = clips.length * 4 + 2
  const charactersLibName = (novelPromotionData.characters || []).map((c) => c.name).join(', ') || '无'
  const locationsLibName = (novelPromotionData.locations || []).map((l) => l.name).join(', ') || '无'
  const charactersIntroduction = buildCharactersIntroduction(novelPromotionData.characters || [])

  const phase1PanelsByClipId = new Map<string, StoryboardPanel[]>()
  const phase2CinematographyByClipId = new Map<string, PhotographyRule[]>()
  const phase2ActingByClipId = new Map<string, ActingDirection[]>()
  const phase3PanelsByClipId = new Map<string, StoryboardPanel[]>()

  const clipPanels = await mapWithConcurrency(
    clips,
    concurrency,
    async (clip, index): Promise<ClipStoryboardPanels> => {
      const clipIndex = index + 1
      const clipContent = typeof clip.content === 'string' ? clip.content.trim() : ''
      if (!clipContent) {
        throw new Error(`Clip ${formatClipId(clip)} content is empty`)
      }
      const clipCharacters = parseClipCharacters(clip.characters)
      const clipLocation = clip.location || null
      const clipProps = parseClipProps(clip.props ?? null)
      const filteredAppearanceList = getFilteredAppearanceList(novelPromotionData.characters || [], clipCharacters)
      const filteredFullDescription = getFilteredFullDescription(novelPromotionData.characters || [], clipCharacters)
      const filteredLocationsDescription = getFilteredLocationsDescription(
        novelPromotionData.locations || [],
        clipLocation,
        input.locale ?? 'zh',
      )
      const filteredPropsDescription = compileAssetPromptFragments(buildPromptAssetContext({
        characters: [],
        locations: [],
        props: novelPromotionData.props || [],
        clipCharacters: [],
        clipLocation: null,
        clipProps,
      })).propsDescriptionText
      const clipJson = JSON.stringify(
        {
          id: clip.id,
          content: clipContent,
          characters: clipCharacters,
          location: clip.location || null,
          props: clipProps,
        },
        null,
        2,
      )

      let phase1Prompt = promptTemplates.phase1PlanTemplate
        .replace('{characters_lib_name}', charactersLibName)
        .replace('{locations_lib_name}', locationsLibName)
        .replace('{characters_introduction}', charactersIntroduction)
        .replace('{characters_appearance_list}', filteredAppearanceList)
        .replace('{characters_full_description}', filteredFullDescription)
        .replace('{props_description}', filteredPropsDescription)
        .replace('{clip_json}', clipJson)

      const screenplay = parseScreenplay(clip.screenplay)
      if (screenplay) {
        phase1Prompt = phase1Prompt.replace('{clip_content}', `【剧本格式】\n${JSON.stringify(screenplay, null, 2)}`)
      } else {
        phase1Prompt = phase1Prompt.replace('{clip_content}', clipContent)
      }

      const phase1Meta = withStepMeta(
        `clip_${clip.id}_phase1`,
        'progress.streamStep.storyboardPlan',
        clipIndex,
        totalStepCount,
        {
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase1',
          retryable: true,
        },
      )
      const { parsed: planPanels } = await runStepWithRetry(
        runStep, phase1Meta, phase1Prompt, 'storyboard_phase1_plan', PHASE1_MAX_OUTPUT_TOKENS,
        (text) => {
          const panels = parseJsonArray<StoryboardPanel>(text, `phase1:${formatClipId(clip)}`)
          if (panels.length === 0) {
            throw new Error(`Phase 1 returned empty panels for clip ${formatClipId(clip)}`)
          }
          return panels
        },
        onStepParsed,
      )
      phase1PanelsByClipId.set(clip.id, planPanels)

      const phase2Meta = withStepMeta(
        `clip_${clip.id}_phase2_cinematography`,
        'progress.streamStep.cinematographyRules',
        clips.length + index * 3 + 1,
        totalStepCount,
        {
          dependsOn: [`clip_${clip.id}_phase1`],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase2ActingMeta = withStepMeta(
        `clip_${clip.id}_phase2_acting`,
        'progress.streamStep.actingDirection',
        clips.length + index * 3 + 2,
        totalStepCount,
        {
          dependsOn: [`clip_${clip.id}_phase1`],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase3Meta = withStepMeta(
        `clip_${clip.id}_phase3_detail`,
        'progress.streamStep.storyboardDetailRefine',
        clips.length + index * 3 + 3,
        totalStepCount,
        {
          dependsOn: [
            `clip_${clip.id}_phase2_cinematography`,
            `clip_${clip.id}_phase2_acting`,
          ],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase3',
          retryable: true,
        },
      )

      const phase2TemplateFilled = promptTemplates.phase2CinematographyTemplate
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{characters_info}', filteredFullDescription)
        .replace('{props_description}', filteredPropsDescription)

      const phase2ActingTemplateFilled = promptTemplates.phase2ActingTemplate
        .replace('{characters_info}', filteredFullDescription)

      const phase3TemplateFilled = promptTemplates.phase3DetailTemplate
        .replace('{characters_age_gender}', filteredFullDescription)
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{props_description}', filteredPropsDescription)

      // 单次请求只处理一个面板分块：面板过多时思考+长 JSON 输出容易在尾部截断/漏格，
      // 分块后每次输出体积可控，覆盖校验按块执行，块内失败只重试该块
      const runChunkedPhase = async <T extends { panel_number?: unknown }>(
        meta: ScriptToStoryboardStepMeta,
        templateFilled: string,
        panels: StoryboardPanel[],
        action: string,
        label: string,
        parseChunk: (text: string, chunkPanels: StoryboardPanel[]) => T[],
      ): Promise<T[]> => {
        const results: T[] = []
        for (const chunk of chunkByPanelCount(panels)) {
          const chunkPrompt = templateFilled
            .replace('{panels_json}', JSON.stringify(chunk, null, 2))
            .replace(/\{panel_count\}/g, String(chunk.length))
          const { parsed } = await runStepWithRetry(
            runStep, meta, chunkPrompt, action, PHASE_STEP_MAX_OUTPUT_TOKENS,
            (text) => parseChunk(text, chunk),
            undefined,
          )
          results.push(...parsed)
        }
        assertPanelNumberCoverage(results, panels, label)
        return results
      }

      const [photographyRules, actingDirections] = await Promise.all([
        runChunkedPhase(
          phase2Meta, phase2TemplateFilled, planPanels, 'storyboard_phase2_cinematography',
          `Phase2 cinematography for clip ${formatClipId(clip)}`,
          (text, chunkPanels) => {
            const rules = parseJsonArray<PhotographyRule>(text, `phase2:${formatClipId(clip)}`)
            assertRulePanelCoverage(rules, chunkPanels, `Phase2 cinematography for clip ${formatClipId(clip)}`)
            return rules
          },
        ),
        runChunkedPhase(
          phase2ActingMeta, phase2ActingTemplateFilled, planPanels, 'storyboard_phase2_acting',
          `Phase2 acting for clip ${formatClipId(clip)}`,
          (text, chunkPanels) => {
            const directions = parseJsonArray<ActingDirection>(text, `phase2-acting:${formatClipId(clip)}`)
            assertRulePanelCoverage(directions, chunkPanels, `Phase2 acting for clip ${formatClipId(clip)}`)
            return directions
          },
        ),
      ])
      onStepParsed?.({ stepKey: phase2Meta.stepId, parsed: photographyRules })
      onStepParsed?.({ stepKey: phase2ActingMeta.stepId, parsed: actingDirections })

      const filteredPhase3Panels = await runChunkedPhase(
        phase3Meta, phase3TemplateFilled, planPanels, 'storyboard_phase3_detail',
        `Phase3 detail for clip ${formatClipId(clip)}`,
        (text, chunkPanels) => {
          const overrides = parseJsonArray<StoryboardPanel>(text, `phase3:${formatClipId(clip)}`)
          assertPanelNumberCoverage(overrides, chunkPanels, `Phase3 detail for clip ${formatClipId(clip)}`)
          const merged = mergePhase3Overrides(chunkPanels, overrides)
          const filtered = merged.filter(
            (panel) => panel.description && panel.description !== '无' && panel.location !== '无',
          )
          if (filtered.length === 0) {
            throw new Error(`Phase 3 returned empty valid panels for clip ${formatClipId(clip)}`)
          }
          return filtered
        },
      )
      onStepParsed?.({ stepKey: phase3Meta.stepId, parsed: filteredPhase3Panels })

      phase2CinematographyByClipId.set(clip.id, photographyRules)
      phase2ActingByClipId.set(clip.id, actingDirections)
      phase3PanelsByClipId.set(clip.id, filteredPhase3Panels)

      return {
        clipId: clip.id,
        clipIndex,
        finalPanels: mergePanelsWithRules({
          finalPanels: filteredPhase3Panels,
          photographyRules,
          actingDirections,
        }),
      }
    },
  )

  const totalPanelCount = clipPanels.reduce((sum, item) => sum + item.finalPanels.length, 0)

  const mapToRecord = <T>(source: Map<string, T>): Record<string, T> => {
    const output: Record<string, T> = {}
    for (const [key, value] of source.entries()) {
      output[key] = value
    }
    return output
  }

  return {
    clipPanels,
    phase1PanelsByClipId: mapToRecord(phase1PanelsByClipId),
    phase2CinematographyByClipId: mapToRecord(phase2CinematographyByClipId),
    phase2ActingByClipId: mapToRecord(phase2ActingByClipId),
    phase3PanelsByClipId: mapToRecord(phase3PanelsByClipId),
    summary: {
      clipCount: clips.length,
      totalPanelCount,
      totalStepCount,
    },
  }
}
