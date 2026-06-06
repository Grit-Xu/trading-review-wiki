import type { LlmConfig } from "@/stores/wiki-store"
import { postJsonViaNativeHttp } from "@/commands/http"
import { getProviderConfig } from "./llm-providers"

export type { ChatMessage } from "./llm-providers"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

const DECODER = new TextDecoder()
const NATIVE_HTTP_TIMEOUT_MS = 15 * 60 * 1000

export function shouldUseNativeHttpForLlm(config: LlmConfig): boolean {
  // Only force native HTTP when explicitly requested via a flag or when
  // fetch streaming is known to fail. By default, custom providers use
  // standard fetch with ReadableStream for true streaming.
  return false
}

export function extractAssistantTextFromResponse(responseText: string): string {
  const parsed = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: string | null } }>
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("No assistant content found")
  }
  return content
}

function createAbortError(): Error {
  const error = new Error("Request aborted")
  error.name = "AbortError"
  return error
}

export function waitForNativeHttpResponse(
  request: Promise<string>,
  signal?: AbortSignal,
  timeoutMs = NATIVE_HTTP_TIMEOUT_MS,
): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      signal?.removeEventListener("abort", onAbort)
    }

    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }

    const onAbort = () => {
      settle(() => reject(createAbortError()))
    }

    timeoutId = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            "Request timed out or network error. The model may need more time — try again or use a faster model.",
          ),
        ),
      )
    }, timeoutMs)

    signal?.addEventListener("abort", onAbort, { once: true })

    request.then(
      (responseText) => settle(() => resolve(responseText)),
      (err) => settle(() => reject(err)),
    )
  })
}

function parseLines(chunk: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + DECODER.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

export async function streamChat(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  const providerConfig = getProviderConfig(config)
  const requestBody = providerConfig.buildBody(messages)

  if (shouldUseNativeHttpForLlm(config)) {
    try {
      const nonStreamingBody =
        requestBody && typeof requestBody === "object"
          ? { ...(requestBody as Record<string, unknown>), stream: false }
          : requestBody
      const responseText = await waitForNativeHttpResponse(
        postJsonViaNativeHttp(
          providerConfig.url,
          providerConfig.headers,
          nonStreamingBody,
        ),
        signal,
      )
      const content = extractAssistantTextFromResponse(responseText)
      onToken(content)
      onDone()
      return
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError" && signal?.aborted) {
        onDone()
        return
      }
      onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
  }

  // Create a combined signal: user abort OR 15-minute timeout
  const timeoutMs = NATIVE_HTTP_TIMEOUT_MS // 15 minutes — some models with large context need a long time
  let combinedSignal = signal
  let timeoutController: AbortController | undefined

  let abortListener: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  if (typeof AbortSignal.timeout === "function") {
    // Combine user signal with timeout
    timeoutController = new AbortController()
    timeoutId = setTimeout(() => timeoutController?.abort(), timeoutMs)

    if (signal) {
      abortListener = () => {
        if (timeoutId) clearTimeout(timeoutId)
        timeoutController?.abort()
      }
      signal.addEventListener("abort", abortListener)
    }
    combinedSignal = timeoutController.signal
  }

  let response: Response
  try {
    response = await fetch(providerConfig.url, {
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(requestBody),
      signal: combinedSignal,
      // @ts-ignore — keepalive hint for Tauri webview
      keepalive: false,
    })
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.message === "Load failed")) {
      // Check if it was user-initiated abort
      if (signal?.aborted) {
        onDone()
        return
      }
      // Otherwise it's a timeout or network error
      onError(new Error("Request timed out or network error. The model may need more time — try again or use a faster model."))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body}`
    } catch {
      // ignore body read failure
    }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  let lineBuffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        if (lineBuffer.trim()) {
          const token = providerConfig.parseStream(lineBuffer.trim())
          if (token !== null) onToken(token)
        }
        break
      }

      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const token = providerConfig.parseStream(trimmed)
        if (token !== null) onToken(token)
      }
    }

    onDone()
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || (signal?.aborted))) {
      onDone()
      return
    }
    if (err instanceof Error && err.message === "Load failed") {
      // WebKit network error during streaming — connection dropped
      onError(new Error("Connection lost during streaming. Try again."))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
    if (timeoutId) clearTimeout(timeoutId)
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener)
    }
  }
}
