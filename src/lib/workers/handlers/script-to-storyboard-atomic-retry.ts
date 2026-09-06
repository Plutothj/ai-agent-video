import { safeParseJsonArray } from '@/lib/json-repair'
import { buildCharactersIntroduction } from '@/lib/constants'
import { normalizeAnyError } from '@/lib/errors/normalize'
import type {
  ScriptToStoryboardPromptTemplates,
  ScriptToStoryboardStepMeta,
  ScriptToStoryboardStepOutput,
} from '@/lib/novel-promotion/script-to-storyboard/orchestrator'
import {
  assertRulePanelCoverage,
} from '@/lib/novel-promotion/script-to-storyboard/orchestrator'
import { listArtifacts } from '@/lib/run-runtime/service'
import {
  assertPanelNumberCoverage,
  chunkByPanelCount,
  mergePhase3Overrides,
  PHASE1_MAX_OUTPUT_TOKENS,
  PHASE_STEP_MAX_OUTPUT_TOKENS,
  type ActingDirection,
  type CharacterAsset,
  type ClipCharacterRef,
  formatClipId,
  getFilteredAppearanceList,
  getFilteredFullDescription,
  getFilteredLocationsDescription,
  type LocationAsset,
  type PropAsset,
  type PhotographyRule,
  type StoryboardPanel,
} from '@/lib/storyboard-phases'
import type { ClipPanelsResult, JsonRecord } from './script-to-storyboard-helpers'
import {
  buildPromptAssetContext,
  compileAssetPromptFragments,
} from '@/lib/assets/services/asset-prompt-context'

type StoryboardClipInput = {
  id: string
  content: string | null
  characters: string | null
  location: string | null
  props?: string | null
  screenplay: string | null
}

export type StoryboardRetryPhase = 'phase1' | 'phase2_cinematography' | 'phase2_acting' | 'phase3_detail'

export type StoryboardRetryTarget = {
  stepKey: string
  clipId: string
  phase: StoryboardRetryPhase
}

export type ScriptToStoryboardAtomicRetryResult = {
  clipPanels: ClipPanelsResult[]
  phase1PanelsByClipId: Record<string, StoryboardPanel[]>
  phase2CinematographyByClipId: Record<string, PhotographyRule[]>
  phase2ActingByClipId: Record<string, ActingDirection[]>
  phase3PanelsByClipId: Record<string, StoryboardPanel[]>
  totalPanelCount: number
  totalStepCount: number
}

type StepRunner = (
  meta: ScriptToStoryboardStepMeta,
  prompt: string,
  action: string,
  maxOutputTokens: number,
) => Promise<ScriptToStoryboardStepOutput>

const MAX_STEP_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 10_000

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asObjectArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is JsonRecord => typeof item === 'object' && item !== null)
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

function parseScreenplay(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid clip screenplay JSON: ${error instanceof Error ? error.message : String(error)}`)
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

function parseJsonArray<T extends JsonRecord>(responseText: string, label: string): T[] {
  const rows = safeParseJsonArray(responseText)
  if (rows.length === 0) {
    throw new Error(`${label}: empty result`)
  }
  return rows as T[]
}

function shouldRetryStepError(error: unknown, message: string, retryable: boolean) {
  if (retryable) return true
  const lowerMessage = message.toLowerCase()
  return lowerMessage.includes('json') || lowerMessage.includes('parse')
}

function computeRetryDelayMs(attempt: number) {
  const base = Math.min(1_000 * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS)
  const jitter = Math.floor(Math.random() * 300)
  return base + jitter
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractArtifactRows<T extends JsonRecord>(payload: unknown, key: string): T[] {
  const record = asObject(payload)
  if (!record) return []
  return asObjectArray(record[key]) as T[]
}

async function readArtifactRows<T extends JsonRecord>(params: {
  runId: string
  clipId: string
  artifactType: string
  key: string
}) {
  const rows = await listArtifacts({
    runId: params.runId,
    artifactType: params.artifactType,
    refId: params.clipId,
    limit: 1,
  })
  const artifact = rows[0]
  if (!artifact) return []
  return extractArtifactRows<T>(artifact.payload, params.key)
}

function getStepNumbers(params: {
  phase: StoryboardRetryPhase
  clipIndex: number
  totalClipCount: number
}) {
  const zeroBasedClipIndex = params.clipIndex
  const totalStepCount = params.totalClipCount * 4 + 2
  if (params.phase === 'phase1') {
    return { stepIndex: zeroBasedClipIndex + 1, stepTotal: totalStepCount }
  }
  if (params.phase === 'phase2_cinematography') {
    return {
      stepIndex: params.totalClipCount + zeroBasedClipIndex * 3 + 1,
      stepTotal: totalStepCount,
    }
  }
  if (params.phase === 'phase2_acting') {
    return {
      stepIndex: params.totalClipCount + zeroBasedClipIndex * 3 + 2,
      stepTotal: totalStepCount,
    }
  }
  return {
    stepIndex: params.totalClipCount + zeroBasedClipIndex * 3 + 3,
    stepTotal: totalStepCount,
  }
}

function buildStepMeta(params: {
  target: StoryboardRetryTarget
  clipIndex: number
  totalClipCount: number
}): ScriptToStoryboardStepMeta {
  const stepNumbers = getStepNumbers({
    phase: params.target.phase,
    clipIndex: params.clipIndex,
    totalClipCount: params.totalClipCount,
  })
  const stepKey = params.target.stepKey
  const groupId = `clip_${params.target.clipId}`

  if (params.target.phase === 'phase1') {
    return {
      stepId: stepKey,
      stepTitle: 'progress.streamStep.storyboardPlan',
      stepIndex: stepNumbers.stepIndex,
      stepTotal: stepNumbers.stepTotal,
      groupId,
      parallelKey: 'phase1',
      retryable: true,
    }
  }
  if (params.target.phase === 'phase2_cinematography') {
    return {
      stepId: stepKey,
      stepTitle: 'progress.streamStep.cinematographyRules',
      stepIndex: stepNumbers.stepIndex,
      stepTotal: stepNumbers.stepTotal,
      dependsOn: [`clip_${params.target.clipId}_phase1`],
      groupId,
      parallelKey: 'phase2',
      retryable: true,
    }
  }
  if (params.target.phase === 'phase2_acting') {
    return {
      stepId: stepKey,
      stepTitle: 'progress.streamStep.actingDirection',
      stepIndex: stepNumbers.stepIndex,
      stepTotal: stepNumbers.stepTotal,
      dependsOn: [`clip_${params.target.clipId}_phase1`],
      groupId,
      parallelKey: 'phase2',
      retryable: true,
    }
  }
  return {
    stepId: stepKey,
    stepTitle: 'progress.streamStep.storyboardDetailRefine',
    stepIndex: stepNumbers.stepIndex,
    stepTotal: stepNumbers.stepTotal,
    dependsOn: [
      `clip_${params.target.clipId}_phase2_cinematography`,
      `clip_${params.target.clipId}_phase2_acting`,
    ],
    groupId,
    parallelKey: 'phase3',
    retryable: true,
  }
}

async function runStepWithRetry<T>(params: {
  runStep: StepRunner
  baseMeta: ScriptToStoryboardStepMeta
  prompt: string
  action: string
  maxOutputTokens: number
  parse: (text: string) => T
  retryStepAttempt: number
  onStepParsed?: (params: { stepKey: string, parsed: unknown }) => Promise<void>
}) {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
    const stepAttempt = params.retryStepAttempt + attempt - 1
    const meta: ScriptToStoryboardStepMeta = {
      ...params.baseMeta,
      stepAttempt,
    }
    try {
      const output = await params.runStep(meta, params.prompt, params.action, params.maxOutputTokens)
      const parsed = params.parse(output.text)
      if (params.onStepParsed) {
        await params.onStepParsed({ stepKey: params.baseMeta.stepId, parsed })
      }
      return parsed
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const normalized = normalizeAnyError(error, { context: 'worker' })
      const shouldRetry = attempt < MAX_STEP_ATTEMPTS
        && shouldRetryStepError(error, normalized.message, normalized.retryable)
      if (!shouldRetry) break
      const retryDelayMs = computeRetryDelayMs(attempt)
      await wait(retryDelayMs)
    }
  }
  throw lastError || new Error('step execution failed')
}

function mergePanelsWithRules(params: {
  finalPanels: StoryboardPanel[]
  photographyRules: PhotographyRule[]
  actingDirections: ActingDirection[]
}) {
  const { finalPanels, photographyRules, actingDirections } = params
  return finalPanels.map((panel, index) => {
    const rule = photographyRules.find((item) => item.panel_number === panel.panel_number)
    if (!rule) {
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
        composition: rule.composition,
        lighting: rule.lighting,
        colorPalette: rule.color_palette,
        atmosphere: rule.atmosphere,
        technicalNotes: rule.technical_notes,
      },
      actingNotes: acting.characters,
    }
  })
}

function requireRows<T extends JsonRecord>(rows: T[], label: string) {
  if (rows.length === 0) {
    throw new Error(`missing dependency artifact: ${label}`)
  }
  return rows
}

export function parseStoryboardRetryTarget(stepKey: string): StoryboardRetryTarget | null {
  const trimmed = stepKey.trim()
  if (!trimmed) return null
  const match = /^clip_(.+)_(phase1|phase2_cinematography|phase2_acting|phase3_detail)$/.exec(trimmed)
  if (!match) return null
  const clipId = (match[1] || '').trim()
  const phase = match[2] as StoryboardRetryPhase
  if (!clipId) return null
  return {
    stepKey: trimmed,
    clipId,
    phase,
  }
}

export async function runScriptToStoryboardAtomicRetry(params: {
  runId: string
  retryTarget: StoryboardRetryTarget
  retryStepAttempt: number
  locale?: 'zh' | 'en'
  clip: StoryboardClipInput
  clipIndex: number
  totalClipCount: number
  novelPromotionData: {
    characters: CharacterAsset[]
    locations: LocationAsset[]
    props?: PropAsset[]
  }
  promptTemplates: ScriptToStoryboardPromptTemplates
  runStep: StepRunner
  onStepParsed?: (params: { stepKey: string, parsed: unknown }) => Promise<void>
}): Promise<ScriptToStoryboardAtomicRetryResult> {
  const clipCharacters = parseClipCharacters(params.clip.characters)
  const clipLocation = params.clip.location || null
  const clipProps = parseClipProps(params.clip.props ?? null)
  const filteredFullDescription = getFilteredFullDescription(params.novelPromotionData.characters || [], clipCharacters)
  const filteredLocationsDescription = getFilteredLocationsDescription(
    params.novelPromotionData.locations || [],
    clipLocation,
    params.locale ?? 'zh',
  )
  const filteredPropsDescription = compileAssetPromptFragments(buildPromptAssetContext({
    characters: [],
    locations: [],
    props: params.novelPromotionData.props || [],
    clipCharacters: [],
    clipLocation: null,
    clipProps,
  })).propsDescriptionText
  const baseMeta = buildStepMeta({
    target: params.retryTarget,
    clipIndex: params.clipIndex,
    totalClipCount: params.totalClipCount,
  })

  const phase1PanelsByClipId: Record<string, StoryboardPanel[]> = {}
  const phase2CinematographyByClipId: Record<string, PhotographyRule[]> = {}
  const phase2ActingByClipId: Record<string, ActingDirection[]> = {}
  const phase3PanelsByClipId: Record<string, StoryboardPanel[]> = {}
  const clipPanels: ClipPanelsResult[] = []

  let phase1Panels = await readArtifactRows<StoryboardPanel>({
    runId: params.runId,
    clipId: params.retryTarget.clipId,
    artifactType: 'storyboard.clip.phase1',
    key: 'panels',
  })
  let phase2Cinematography = await readArtifactRows<PhotographyRule>({
    runId: params.runId,
    clipId: params.retryTarget.clipId,
    artifactType: 'storyboard.clip.phase2.cine',
    key: 'rules',
  })
  let phase2Acting = await readArtifactRows<ActingDirection>({
    runId: params.runId,
    clipId: params.retryTarget.clipId,
    artifactType: 'storyboard.clip.phase2.acting',
    key: 'directions',
  })
  let phase3Panels = await readArtifactRows<StoryboardPanel>({
    runId: params.runId,
    clipId: params.retryTarget.clipId,
    artifactType: 'storyboard.clip.phase3',
    key: 'panels',
  })

  if (params.retryTarget.phase === 'phase1') {
    const clipContent = typeof params.clip.content === 'string' ? params.clip.content.trim() : ''
    if (!clipContent) {
      throw new Error(`Clip ${formatClipId(params.clip)} content is empty`)
    }
    const filteredAppearanceList = getFilteredAppearanceList(params.novelPromotionData.characters || [], clipCharacters)
    const charactersLibName = (params.novelPromotionData.characters || []).map((item) => item.name).join(', ') || '无'
    const locationsLibName = (params.novelPromotionData.locations || []).map((item) => item.name).join(', ') || '无'
    const charactersIntroduction = buildCharactersIntroduction(params.novelPromotionData.characters || [])
    const clipJson = JSON.stringify(
      {
        id: params.clip.id,
        content: clipContent,
        characters: clipCharacters,
        location: clipLocation,
        props: clipProps,
      },
      null,
      2,
    )
    let phase1Prompt = params.promptTemplates.phase1PlanTemplate
      .replace('{characters_lib_name}', charactersLibName)
      .replace('{locations_lib_name}', locationsLibName)
      .replace('{characters_introduction}', charactersIntroduction)
      .replace('{characters_appearance_list}', filteredAppearanceList)
      .replace('{characters_full_description}', filteredFullDescription)
      .replace('{props_description}', filteredPropsDescription)
      .replace('{clip_json}', clipJson)
    const screenplay = parseScreenplay(params.clip.screenplay)
    if (screenplay) {
      phase1Prompt = phase1Prompt.replace('{clip_content}', `【剧本格式】\n${JSON.stringify(screenplay, null, 2)}`)
    } else {
      phase1Prompt = phase1Prompt.replace('{clip_content}', clipContent)
    }
    phase1Panels = await runStepWithRetry({
      runStep: params.runStep,
      baseMeta,
      prompt: phase1Prompt,
      action: 'storyboard_phase1_plan',
      maxOutputTokens: PHASE1_MAX_OUTPUT_TOKENS,
      parse: (text) => {
        const panels = parseJsonArray<StoryboardPanel>(text, `phase1:${formatClipId(params.clip)}`)
        if (panels.length === 0) {
          throw new Error(`Phase 1 returned empty panels for clip ${formatClipId(params.clip)}`)
        }
        return panels
      },
      retryStepAttempt: params.retryStepAttempt,
      onStepParsed: params.onStepParsed,
    })
    phase1PanelsByClipId[params.clip.id] = phase1Panels
    // phase1 重跑后旧下游产物全部失效，后续阶段按缺失重新计算
    phase2Cinematography = []
    phase2Acting = []
    phase3Panels = []
  }
  const planPanels = requireRows(phase1Panels, 'storyboard.clip.phase1')

  // ===== 断点续跑 =====
  // 旧逻辑按目标阶段 if/else 分支并要求所有下游产物已存在——phase2 失败时 phase3 产物
  // 不存在，重试必然死在 requireRows。这里改为顺序补齐：目标阶段重跑，缺失的下游阶段直接接着跑。

  const targetFor = (phase: StoryboardRetryPhase): StoryboardRetryTarget => ({
    stepKey: `clip_${params.retryTarget.clipId}_${phase}`,
    clipId: params.retryTarget.clipId,
    phase,
  })
  const metaFor = (phase: StoryboardRetryPhase) =>
    buildStepMeta({ target: targetFor(phase), clipIndex: params.clipIndex, totalClipCount: params.totalClipCount })

  // 分块执行器：与主流程一致，面板过多时单次请求容易在尾部截断/漏格
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
      const parsed = await runStepWithRetry({
        runStep: params.runStep,
        baseMeta: meta,
        prompt: chunkPrompt,
        action,
        maxOutputTokens: PHASE_STEP_MAX_OUTPUT_TOKENS,
        parse: (text) => parseChunk(text, chunk),
        retryStepAttempt: params.retryStepAttempt,
      })
      results.push(...parsed)
    }
    assertPanelNumberCoverage(results, panels, label)
    return results
  }

  if (params.retryTarget.phase === 'phase2_cinematography' || phase2Cinematography.length === 0) {
    const phase2TemplateFilled = params.promptTemplates.phase2CinematographyTemplate
      .replace('{locations_description}', filteredLocationsDescription)
      .replace('{characters_info}', filteredFullDescription)
      .replace('{props_description}', filteredPropsDescription)
    phase2Cinematography = await runChunkedPhase(
      metaFor('phase2_cinematography'), phase2TemplateFilled, planPanels,
      'storyboard_phase2_cinematography', `Phase2 cinematography for clip ${formatClipId(params.clip)}`,
      (text, chunkPanels) => {
        const rules = parseJsonArray<PhotographyRule>(text, `phase2:${formatClipId(params.clip)}`)
        assertRulePanelCoverage(rules, chunkPanels, `Phase2 cinematography for clip ${formatClipId(params.clip)}`)
        return rules
      },
    )
    phase2CinematographyByClipId[params.clip.id] = phase2Cinematography
    params.onStepParsed?.({ stepKey: targetFor('phase2_cinematography').stepKey, parsed: phase2Cinematography })
  }

  if (params.retryTarget.phase === 'phase2_acting' || phase2Acting.length === 0) {
    const phase2ActingTemplateFilled = params.promptTemplates.phase2ActingTemplate
      .replace('{characters_info}', filteredFullDescription)
    phase2Acting = await runChunkedPhase(
      metaFor('phase2_acting'), phase2ActingTemplateFilled, planPanels,
      'storyboard_phase2_acting', `Phase2 acting for clip ${formatClipId(params.clip)}`,
      (text, chunkPanels) => {
        const directions = parseJsonArray<ActingDirection>(text, `phase2-acting:${formatClipId(params.clip)}`)
        assertRulePanelCoverage(directions, chunkPanels, `Phase2 acting for clip ${formatClipId(params.clip)}`)
        return directions
      },
    )
    phase2ActingByClipId[params.clip.id] = phase2Acting
    params.onStepParsed?.({ stepKey: targetFor('phase2_acting').stepKey, parsed: phase2Acting })
  }

  if (params.retryTarget.phase === 'phase3_detail' || phase3Panels.length === 0) {
    const phase3TemplateFilled = params.promptTemplates.phase3DetailTemplate
      .replace('{characters_age_gender}', filteredFullDescription)
      .replace('{locations_description}', filteredLocationsDescription)
      .replace('{props_description}', filteredPropsDescription)
    phase3Panels = await runChunkedPhase(
      metaFor('phase3_detail'), phase3TemplateFilled, planPanels,
      'storyboard_phase3_detail', `Phase3 detail for clip ${formatClipId(params.clip)}`,
      (text, chunkPanels) => {
        const overrides = parseJsonArray<StoryboardPanel>(text, `phase3:${formatClipId(params.clip)}`)
        assertPanelNumberCoverage(overrides, chunkPanels, `Phase3 detail for clip ${formatClipId(params.clip)}`)
        const merged = mergePhase3Overrides(chunkPanels, overrides)
        const filtered = merged.filter(
          (panel) => panel.description && panel.description !== '无' && panel.location !== '无',
        )
        if (filtered.length === 0) {
          throw new Error(`Phase 3 returned empty valid panels for clip ${formatClipId(params.clip)}`)
        }
        return filtered
      },
    )
    phase3PanelsByClipId[params.clip.id] = phase3Panels
    params.onStepParsed?.({ stepKey: targetFor('phase3_detail').stepKey, parsed: phase3Panels })
  }

  const finalPanels = mergePanelsWithRules({
    finalPanels: requireRows(phase3Panels, 'storyboard.clip.phase3'),
    photographyRules: requireRows(phase2Cinematography, 'storyboard.clip.phase2.cine'),
    actingDirections: requireRows(phase2Acting, 'storyboard.clip.phase2.acting'),
  })
  clipPanels.push({
    clipId: params.clip.id,
    clipIndex: params.clipIndex + 1,
    finalPanels,
  })

  const totalPanelCount = clipPanels.reduce((sum, item) => sum + item.finalPanels.length, 0)
  return {
    clipPanels,
    phase1PanelsByClipId,
    phase2CinematographyByClipId,
    phase2ActingByClipId,
    phase3PanelsByClipId,
    totalPanelCount,
    totalStepCount: params.totalClipCount * 4 + 2,
  }
}
