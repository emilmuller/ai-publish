import { describe, expect, it } from "vitest"

import { azureChatCompletion } from "../src/llm/azureOpenAI/http"
import type { AzureOpenAIConfig } from "../src/llm/azureOpenAI/config"

describe("azureOpenAI Structured Outputs apiVersion gating", () => {
	it("fails fast on old AZURE_OPENAI_API_VERSION when response_format is json_schema", async () => {
		const cfg: AzureOpenAIConfig = {
			endpoint: "https://example.test",
			apiKey: "test-key",
			deployment: "test-deployment",
			apiVersion: "2024-06-01-preview",
			requestTimeoutMs: 10_000
		}

		const prev = process.env.AZURE_OPENAI_USE_RESPONSES
		process.env.AZURE_OPENAI_USE_RESPONSES = "0"
		try {
			await expect(
				azureChatCompletion(cfg, {
					messages: [{ role: "user", content: "hi" }],
					responseFormat: {
						type: "json_schema",
						json_schema: {
							name: "t",
							strict: true,
							schema: { type: "object", properties: {}, additionalProperties: false }
						}
					}
				})
			).rejects.toThrow(/AZURE_OPENAI_API_VERSION/i)
		} finally {
			if (prev === undefined) delete process.env.AZURE_OPENAI_USE_RESPONSES
			else process.env.AZURE_OPENAI_USE_RESPONSES = prev
		}
	})
})
