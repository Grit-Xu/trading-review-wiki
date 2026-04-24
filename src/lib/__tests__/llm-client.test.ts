import { describe, expect, it, vi } from "vitest"
import {
  extractAssistantTextFromResponse,
  shouldUseNativeHttpForLlm,
  waitForNativeHttpResponse,
} from "@/lib/llm-client"

describe("llm-client native transport selection", () => {
  it("prefers fetch streaming for all providers by default", () => {
    // After PR #4 fix verification, we keep native HTTP available as a
    // fallback but default to fetch ReadableStream for true streaming.
    expect(
      shouldUseNativeHttpForLlm({
        provider: "custom",
        apiKey: "k",
        model: "glm-5",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "https://example.com/v1",
        maxContextSize: 204800,
      }),
    ).toBe(false)
  })

  it("does not use native HTTP for standard openai provider", () => {
    expect(
      shouldUseNativeHttpForLlm({
        provider: "openai",
        apiKey: "k",
        model: "gpt-4o",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 204800,
      }),
    ).toBe(false)
  })
})

describe("llm-client non-streaming response parsing", () => {
  it("extracts assistant content from an OpenAI-compatible response", () => {
    const text = extractAssistantTextFromResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "交易建议",
            },
          },
        ],
      }),
    )

    expect(text).toBe("交易建议")
  })

  it("throws when assistant content is missing", () => {
    expect(() =>
      extractAssistantTextFromResponse(
        JSON.stringify({
          choices: [{ message: { role: "assistant" } }],
        }),
      ),
    ).toThrow("No assistant content found")
  })
})

describe("llm-client native transport timeout and abort", () => {
  it("rejects native HTTP waits after the configured timeout", async () => {
    vi.useFakeTimers()
    try {
      const request = new Promise<string>(() => {})
      const response = waitForNativeHttpResponse(request, undefined, 100)
      const assertion = expect(response).rejects.toThrow("Request timed out")

      await vi.advanceTimersByTimeAsync(100)

      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects native HTTP waits when the caller aborts", async () => {
    const controller = new AbortController()
    const request = new Promise<string>(() => {})
    const response = waitForNativeHttpResponse(request, controller.signal, 1000)
    const assertion = expect(response).rejects.toMatchObject({
      name: "AbortError",
    })

    controller.abort()

    await assertion
  })
})
