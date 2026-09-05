import OpenAI from 'openai'
import { collectTextValue, extractCompletionPartsFromContent } from './utils'
import { _ulogError } from './runtime-shared'

export function getCompletionContent(completion: OpenAI.Chat.Completions.ChatCompletion): string {
  return getCompletionParts(completion).text
}

export function getCompletionParts(completion: OpenAI.Chat.Completions.ChatCompletion): {
  text: string
  reasoning: string
} {
  if (!completion || !completion.choices || completion.choices.length === 0) {
    _ulogError(
      '[LLM] ❌ 返回无效响应 - 完整对象:',
      JSON.stringify(completion, null, 2).substring(0, 2000),
    )
    throw new Error('LLM 返回无效响应')
  }

  const message = completion.choices[0]?.message
  if (!message) {
    _ulogError(
      '[LLM] ❌ 响应中没有消息内容 - choices[0]:',
      JSON.stringify(completion.choices[0], null, 2).substring(0, 1000),
    )
    throw new Error('LLM 响应中没有消息内容')
  }

  const content = message.content
  const parsed = extractCompletionPartsFromContent(content)
  // DeepSeek/Kimi 风格 provider（如腾讯云 TokenHub）在非流式响应中
  // 把思考内容放在 message.reasoning_content 字段，content 只含正文
  const messageReasoning =
    collectTextValue((message as { reasoning_content?: unknown }).reasoning_content) ||
    collectTextValue((message as { reasoning?: unknown }).reasoning)
  return {
    text: parsed.text,
    reasoning: parsed.reasoning || messageReasoning,
  }
}
