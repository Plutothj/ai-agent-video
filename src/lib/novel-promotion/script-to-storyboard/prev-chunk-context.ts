import type { ActingDirection, PhotographyRule, StoryboardPanel } from '@/lib/storyboard-phases'

// 分块调用（chunkByPanelCount）把一组面板拆成多次独立的 LLM 请求，块与块之间默认零上下文，
// 跨块的镜头衔接、轴线（screen_position 左右关系）、光线色调会因此断裂。
// 这里为每个分块请求构造附带的"前文上下文"块，让后续分块能看到紧邻的前文产物。

// 随每个分块请求附带的前文条目数（紧邻本块之前的 N 个）
export const PREV_CHUNK_ITEM_COUNT = 2

export function slicePrevItems<T>(items: T[], chunkStartIndex: number, count = PREV_CHUNK_ITEM_COUNT): T[] {
    return items.slice(Math.max(0, chunkStartIndex - count), chunkStartIndex)
}

type BilingualSubject = { zh: string; en: string }

export function buildPrevChunkContextBlock(
    locale: 'zh' | 'en',
    subject: BilingualSubject,
    json: string,
): string {
    if (locale === 'en') {
        return [
            '',
            `【Previous-chunk context — ${subject.en} (already produced, for continuity reference ONLY)】`,
            'When designing the current chunk, stay continuous with the context above: actions hand off naturally, characters keep the same screen side and axis within the same scene, lighting and color tone stay consistent.',
            'Do NOT re-output the context entries; only output records whose panel_number belongs to the current chunk:',
            json,
        ].join('\n')
    }
    return [
        '',
        `【前文上下文 — ${subject.zh}（已生成完毕，仅供衔接参考）】`,
        '设计本组分镜时必须与前文保持连贯：动作自然承接、同场景角色的屏幕左右位置与轴线一致、光线色调一致。',
        '禁止重复输出前文条目，只输出本组 panel_number 对应的内容：',
        json,
    ].join('\n')
}

// phase3 上下文用：把前文面板与已算出的摄影/表演规则软合并（缺规则时置 null，不抛错）
export function serializePrevPanelsWithRules(params: {
    prevPanels: StoryboardPanel[]
    photographyRules: PhotographyRule[]
    actingDirections: ActingDirection[]
}): string {
    const { prevPanels, photographyRules, actingDirections } = params
    const merged = prevPanels.map((panel) => ({
        ...panel,
        photographyPlan: photographyRules.find((rule) => rule.panel_number === panel.panel_number) ?? null,
        actingNotes: actingDirections.find((item) => item.panel_number === panel.panel_number)?.characters ?? null,
    }))
    return JSON.stringify(merged, null, 2)
}
