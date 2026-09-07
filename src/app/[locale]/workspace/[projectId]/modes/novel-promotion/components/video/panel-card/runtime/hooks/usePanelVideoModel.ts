import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoModelOption, VideoGenerationOptionValue, VideoGenerationOptions } from '../../../types'
import type { CapabilitySelections } from '@/lib/model-config-contract'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'

interface UsePanelVideoModelParams {
  defaultVideoModel: string
  capabilityOverrides?: CapabilitySelections
  userVideoModels?: VideoModelOption[]
  /** 分镜规划的目标时长（秒）：用户未手动选择时长时，作为默认档位吸附到模型支持的最近选项 */
  preferredDuration?: number
}

interface CapabilityField {
  field: string
  label: string
  labelKey?: string
  unitKey?: string
  optionLabelKeys?: Record<string, string>
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGenerationOptionValue(value: unknown): value is VideoGenerationOptionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function pickNearestDurationOption(
  preferred: number,
  options: VideoGenerationOptionValue[],
): VideoGenerationOptionValue | undefined {
  const numericOptions = options.filter((option): option is number => typeof option === 'number')
  if (numericOptions.length === 0) return undefined
  return numericOptions.slice().sort((left, right) => {
    const leftDelta = Math.abs(left - preferred)
    const rightDelta = Math.abs(right - preferred)
    if (leftDelta !== rightDelta) return leftDelta - rightDelta
    return right - left
  })[0]
}

function readSelectionForModel(
  capabilityOverrides: CapabilitySelections | undefined,
  modelKey: string,
): VideoGenerationOptions {
  if (!modelKey || !capabilityOverrides) return {}
  const rawSelection = capabilityOverrides[modelKey]
  if (!isRecord(rawSelection)) return {}

  const selection: VideoGenerationOptions = {}
  for (const [field, value] of Object.entries(rawSelection)) {
    if (field === 'aspectRatio') continue
    if (!isGenerationOptionValue(value)) continue
    selection[field] = value
  }
  return selection
}

export function usePanelVideoModel({
  defaultVideoModel,
  capabilityOverrides,
  userVideoModels,
  preferredDuration,
}: UsePanelVideoModelParams) {
  const [selectedModel, setSelectedModel] = useState(defaultVideoModel || '')
  // 用户是否手动改过时长：区分「用户在弹窗里主动选了时长」与「初始化自动填入默认档位」。
  // 自动填入的值（normalizeVideoGenerationSelections 会填 compatibleOptions[0]）会污染
  // selectedModelOverrides.duration，若不作区分会永远屏蔽分镜目标时长，弹窗恒显示最短档。
  const [durationManuallySelected, setDurationManuallySelected] = useState(false)
  const [generationOptions, setGenerationOptions] = useState<VideoGenerationOptions>(() =>
    readSelectionForModel(capabilityOverrides, defaultVideoModel || ''),
  )
  const videoModelOptions = userVideoModels ?? []
  const selectedOption = videoModelOptions.find((option) => option.value === selectedModel)
  const pricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'normal',
      },
    }),
    [selectedOption?.videoPricingTiers],
  )

  useEffect(() => {
    setSelectedModel(defaultVideoModel || '')
  }, [defaultVideoModel])

  // 分镜目标时长由「无」变「有」时（面板数据异步加载完成），重置手动选择标记，
  // 让该面板重新吸附到自己的规划时长；用户手动改过后的值只在当前面板内固定。
  const prevPreferredDurationRef = useRef<number | undefined>(preferredDuration === undefined ? undefined : -1)
  useEffect(() => {
    const previous = prevPreferredDurationRef.current
    const next = typeof preferredDuration === 'number' && Number.isFinite(preferredDuration) && preferredDuration > 0
      ? preferredDuration
      : undefined
    if (previous === undefined && next !== undefined) {
      setDurationManuallySelected(false)
    }
    prevPreferredDurationRef.current = next
  }, [preferredDuration])

  useEffect(() => {
    if (!selectedModel) {
      if (videoModelOptions.length > 0) {
        setSelectedModel(videoModelOptions[0].value)
      }
      return
    }
    if (videoModelOptions.some((option) => option.value === selectedModel)) return
    setSelectedModel(videoModelOptions[0]?.value || '')
  }, [selectedModel, videoModelOptions])

  const capabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedOption?.capabilities?.video,
      pricingTiers,
    }),
    [pricingTiers, selectedOption?.capabilities?.video],
  )

  const selectedModelOverrides = useMemo(
    () => readSelectionForModel(capabilityOverrides, selectedModel),
    [capabilityOverrides, selectedModel],
  )

  // 分镜目标时长吸附：仅当用户没有手动选过该模型的时长时才作为默认值
  const preferredDurationSeed = useMemo(() => {
    if (typeof preferredDuration !== 'number' || !Number.isFinite(preferredDuration) || preferredDuration <= 0) {
      return undefined
    }
    if (durationManuallySelected) return undefined
    const durationDefinition = capabilityDefinitions.find((definition) => definition.field === 'duration')
    if (!durationDefinition) return undefined
    return pickNearestDurationOption(preferredDuration, durationDefinition.options)
  }, [capabilityDefinitions, preferredDuration, durationManuallySelected])

  // 模型或 config 预设变化时，以「该模型 config 预设」重置 generationOptions。
  // 用户在同一模型内对其它字段的改动会在之后被吸附 effect 保留；切换模型则回到该模型预设。
  const selectedModelOverridesSignature = useMemo(
    () => JSON.stringify(selectedModelOverrides),
    [selectedModelOverrides],
  )
  // selectedModelOverridesSignature 是 selectedModelOverrides 的字符串指纹，已代表其值变化；
  // 直接依赖 selectedModelOverrides 会因其每次渲染改引用而触发不必要(且有循环风险)的 effect，
  // 故这里以 signature 为依赖，eslint 静态分析不识别该别名，特此关闭该行警告。
  useEffect(() => {
    setGenerationOptions(normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: selectedModelOverrides,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, selectedModelOverridesSignature, capabilityDefinitions, pricingTiers])

  // 吸附 effect：用户未手动选时长时，把 duration 吸附到分镜目标时长（只改 duration，保留其它字段）。
  useEffect(() => {
    if (durationManuallySelected) return
    if (preferredDurationSeed === undefined) return
    setGenerationOptions((previous) => {
      if (previous.duration === preferredDurationSeed) return previous
      return normalizeVideoGenerationSelections({
        definitions: capabilityDefinitions,
        pricingTiers,
        selection: {
          ...previous,
          duration: preferredDurationSeed,
        },
      })
    })
  }, [preferredDurationSeed, durationManuallySelected, capabilityDefinitions, pricingTiers])

  const effectiveFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: generationOptions,
    }),
    [capabilityDefinitions, generationOptions, pricingTiers],
  )
  const missingCapabilityFields = useMemo(
    () => effectiveFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [effectiveFields],
  )
  const effectiveFieldMap = useMemo(
    () => new Map(effectiveFields.map((field) => [field.field, field])),
    [effectiveFields],
  )
  const definitionFieldMap = useMemo(
    () => new Map(capabilityDefinitions.map((definition) => [definition.field, definition])),
    [capabilityDefinitions],
  )
  const capabilityFields: CapabilityField[] = useMemo(() => {
    return capabilityDefinitions.map((definition) => {
      const effectiveField = effectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        labelKey: definition.fieldI18n?.labelKey,
        unitKey: definition.fieldI18n?.unitKey,
        optionLabelKeys: definition.fieldI18n?.optionLabelKeys,
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [capabilityDefinitions, effectiveFieldMap])

  const setCapabilityValue = (field: string, rawValue: string) => {
    const definitionField = definitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    // 用户主动改过时长后，分镜目标时长不再覆盖，以用户手选值为准
    if (field === 'duration') {
      setDurationManuallySelected(true)
    }
    setGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: capabilityDefinitions,
        pricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
  }

  return {
    selectedModel,
    setSelectedModel,
    generationOptions,
    capabilityFields,
    setCapabilityValue,
    missingCapabilityFields,
    videoModelOptions,
  }
}
