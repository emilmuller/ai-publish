import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const { azureChatCompletionWithMetaMock } = vi.hoisted(() => ({
	azureChatCompletionWithMetaMock: vi.fn()
}))

vi.mock("../src/llm/azureOpenAI/http", () => ({
	azureChatCompletionWithMeta: azureChatCompletionWithMetaMock
}))

import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import type { MechanicalPassInput } from "../src/llm/types"

const originalAzureEnv = {
	endpoint: process.env.AZURE_OPENAI_ENDPOINT,
	apiKey: process.env.AZURE_OPENAI_API_KEY,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
	apiVersion: process.env.AZURE_OPENAI_API_VERSION
}

function makeMechanicalInput(): MechanicalPassInput {
	return {
		base: "HEAD~1",
		diffSummary: {
			baseSha: "base-sha",
			headSha: "head-sha",
			totalHunks: 3,
			files: [
				{ path: "src/llm/azureOpenAI/createClient.ts", changeType: "modify", isBinary: false },
				{ path: "src/llm/azureOpenAI/parseAndCoerce.ts", changeType: "modify", isBinary: false },
				{ path: "test/structured-json-retry.test.ts", changeType: "add", isBinary: false }
			]
		},
		diffIndexManifest: {
			schemaVersion: 1,
			baseSha: "base-sha",
			headSha: "head-sha",
			files: [
				{
					path: "src/llm/azureOpenAI/createClient.ts",
					changeType: "modify",
					isBinary: false,
					hunkIds: ["h1", "h2"]
				},
				{
					path: "src/llm/azureOpenAI/parseAndCoerce.ts",
					changeType: "modify",
					isBinary: false,
					hunkIds: ["h3"]
				},
				{ path: "test/structured-json-retry.test.ts", changeType: "add", isBinary: false, hunkIds: ["h4"] }
			]
		},
		evidence: {
			"08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c": {
				id: "08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c",
				filePath: "src/llm/azureOpenAI/createClient.ts",
				changeType: "modify",
				surface: "internal",
				hunkIds: ["h1", "h2"],
				isBinary: false
			},
			"66b59f5f57c6754fd6467fee1fcc7e9b9ed224ad1b2bb898a7380e557a7f6218": {
				id: "66b59f5f57c6754fd6467fee1fcc7e9b9ed224ad1b2bb898a7380e557a7f6218",
				filePath: "src/llm/azureOpenAI/parseAndCoerce.ts",
				changeType: "modify",
				surface: "internal",
				hunkIds: ["h3"],
				isBinary: false
			},
			"8c7147a9bc815fa0031648fee857808261876e0d06424d9fdc51cee01422999b": {
				id: "8c7147a9bc815fa0031648fee857808261876e0d06424d9fdc51cee01422999b",
				filePath: "test/structured-json-retry.test.ts",
				changeType: "add",
				surface: "tests",
				hunkIds: ["h4"],
				isBinary: false
			}
		},
		deterministicFacts: ["3 files changed: 2 modified and 1 added."]
	}
}

describe("azure structured JSON retries", () => {
	beforeEach(() => {
		azureChatCompletionWithMetaMock.mockReset()
		process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com"
		process.env.AZURE_OPENAI_API_KEY = "test-key"
		process.env.AZURE_OPENAI_DEPLOYMENT = "test-deployment"
		process.env.AZURE_OPENAI_API_VERSION = "2024-08-01-preview"
	})

	afterAll(() => {
		process.env.AZURE_OPENAI_ENDPOINT = originalAzureEnv.endpoint
		process.env.AZURE_OPENAI_API_KEY = originalAzureEnv.apiKey
		process.env.AZURE_OPENAI_DEPLOYMENT = originalAzureEnv.deployment
		process.env.AZURE_OPENAI_API_VERSION = originalAzureEnv.apiVersion
	})

	it("retries more than once and keeps mechanical prompts compact", async () => {
		azureChatCompletionWithMetaMock
			.mockResolvedValueOnce({
				content:
					'{"notes":["3 files changed: 2 modified and 1 added. (evidenceNodeIds: 08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c)"',
				finishReason: null,
				usage: null
			})
			.mockResolvedValueOnce({
				content: '{"notes":["Still truncated"',
				finishReason: null,
				usage: null
			})
			.mockResolvedValueOnce({
				content:
					'{"notes":["3 files changed: 2 modified and 1 added.","Updated internal Azure structured JSON handling. (evidenceNodeIds: 08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c)","Added retry regression tests."]}',
				finishReason: null,
				usage: null
			})

		const client = createAzureOpenAILLMClient()
		const result = await client.pass1Mechanical(makeMechanicalInput())

		expect(result.notes).toEqual([
			"3 files changed: 2 modified and 1 added.",
			"Updated internal Azure structured JSON handling.",
			"Added retry regression tests."
		])
		expect(azureChatCompletionWithMetaMock).toHaveBeenCalledTimes(3)
		expect(azureChatCompletionWithMetaMock.mock.calls[0]?.[1]?.maxTokens).toBe(2000)
		expect(azureChatCompletionWithMetaMock.mock.calls[1]?.[1]?.maxTokens).toBe(4000)
		expect(azureChatCompletionWithMetaMock.mock.calls[2]?.[1]?.maxTokens).toBe(8000)

		const userContent = azureChatCompletionWithMetaMock.mock.calls[0]?.[1]?.messages?.[1]?.content
		expect(userContent).toContain("Evidence summary (metadata only; no patch text):")
		expect(userContent).not.toContain("evidenceNodeIds")
		expect(userContent).not.toContain("08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c")
		expect(userContent).toContain("hunks: 2")
	})
})
