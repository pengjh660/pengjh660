import { type ClientOptions } from '@anthropic-ai/sdk'
import type { OpenAIChatResponse } from '../../server/proxy/transform/types.js'
import { anthropicToOpenaiChat } from '../../server/proxy/transform/anthropicToOpenaiChat.js'
import { openaiChatToAnthropic } from '../../server/proxy/transform/openaiChatToAnthropic.js'
import { openaiChatStreamToAnthropic } from '../../server/proxy/streaming/openaiChatStreamToAnthropic.js'
import { logForDebugging } from '../../utils/debug.js'

export function isOpenAIChatProvider(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_OPENAI_CHAT)
}

function resolveChatCompletionsUrl(): string {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.openai.com/v1'
  const normalized = base.replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) return normalized
  return `${normalized}/chat/completions`
}

function resolveOpenAIToken(): string {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENAI_API_KEY || ''
}

function isEnvTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes'
}

export function buildOpenAIChatFetch(
  fetchOverride: ClientOptions['fetch'],
  _source: string | undefined,
): ClientOptions['fetch'] {
  const inner = fetchOverride ?? globalThis.fetch

  return (async (input: RequestInfo | URL, init: RequestInit | undefined) => {
    const urlStr = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)

    if (init?.method !== 'POST' || !urlStr.includes('/v1/messages')) {
      return inner(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const rawBody =
        typeof init.body === 'string'
          ? init.body
          : init.body instanceof ArrayBuffer
            ? new TextDecoder().decode(init.body)
            : init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : String(init.body)
      anthropicBody = JSON.parse(rawBody)
    } catch {
      return inner(input, init)
    }

    const openaiUrl = resolveChatCompletionsUrl()
    const openaiToken = resolveOpenAIToken()

    const model = String(anthropicBody.model || 'gpt-4o')

    const openaiRequest = anthropicToOpenaiChat({
      model,
      messages: anthropicBody.messages as any,
      system: anthropicBody.system as string | Array<{ type: 'text'; text: string; cache_control?: unknown }> | undefined,
      max_tokens: (anthropicBody.max_tokens as number) || 4096,
      temperature: anthropicBody.temperature as number | undefined,
      top_p: anthropicBody.top_p as number | undefined,
      stop_sequences: anthropicBody.stop_sequences as string[] | undefined,
      tools: anthropicBody.tools as any,
      tool_choice: anthropicBody.tool_choice,
      thinking: anthropicBody.thinking as any,
      stream: true,
    })

    logForDebugging(`[OpenAI] POST ${openaiUrl} model=${model}`)

    const openaiResponse = await inner(openaiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(openaiToken ? { Authorization: `Bearer ${openaiToken}` } : {}),
      },
      body: JSON.stringify(openaiRequest),
      signal: init.signal,
    })

    if (!openaiResponse.ok) {
      const errorBody = await openaiResponse.text().catch(() => '')
      logForDebugging(`[OpenAI] Error ${openaiResponse.status}: ${errorBody.slice(0, 500)}`)
      return new Response(errorBody, {
        status: openaiResponse.status,
        statusText: openaiResponse.statusText,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (anthropicBody.stream) {
      const convertedStream = openaiChatStreamToAnthropic(openaiResponse.body!, model)
      return new Response(convertedStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const openaiJson: OpenAIChatResponse = await openaiResponse.json()
    const anthropicResponse = openaiChatToAnthropic(openaiJson, model)
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as ClientOptions['fetch']
}

