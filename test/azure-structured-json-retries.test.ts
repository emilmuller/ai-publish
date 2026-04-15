import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const { azureChatCompletionWithMetaMock } = vi.hoisted(() => ({
	azureChatCompletionWithMetaMock: vi.fn()
}))

vi.mock("../src/llm/azureOpenAI/http", () => ({
	azureChatCompletionWithMeta: azureChatCompletionWithMetaMock
}))

import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import type { MechanicalPassInput, SemanticPassInput, SemanticTools } from "../src/llm/types"

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

function makeEditorialInput() {
	const mechanical = makeMechanicalInput()
	return {
		mechanical: {
			notes: [
				"Improved structured JSON retry handling for editorial output.",
				"Added regression coverage for repeated truncation."
			]
		},
		semantic: {
			notes: ["Editorial output should cite only the minimum supporting evidence for each user-facing bullet."]
		},
		evidence: mechanical.evidence
	}
}

function makeSemanticInput(): SemanticPassInput {
	const mechanical = makeMechanicalInput()
	return {
		base: mechanical.base,
		mechanical: {
			notes: [
				"Breaking API contract changes need confirmation against entrypoints.",
				"New admin and knowledge APIs were added."
			]
		},
		evidence: mechanical.evidence
	}
}

const semanticTools: SemanticTools = {
	getDiffHunks: async () => [],
	getRepoFileSnippets: async () => [],
	getRepoSnippetAround: async () => [],
	getRepoFileMeta: async () => [],
	searchRepoFiles: async () => [],
	searchRepoPaths: async () => [],
	searchRepoText: async () => [],
	listRepoFiles: async () => []
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

	it("uses compact evidence refs for editorial output and expands them back to real evidence ids", async () => {
		azureChatCompletionWithMetaMock.mockResolvedValueOnce({
			content: JSON.stringify({
				breakingChanges: [],
				added: [],
				changed: [
					{
						text: "Improved resilience when structured changelog output is truncated.",
						evidenceNodeIds: ["E1", "e2"]
					}
				],
				fixed: [],
				removed: [],
				internalTooling: [
					{
						text: "Added regression tests for compact editorial evidence refs.",
						evidenceNodeIds: ["ref: E3"]
					}
				]
			}),
			finishReason: null,
			usage: null
		})

		const client = createAzureOpenAILLMClient()
		const result = await client.pass3Editorial(makeEditorialInput())

		expect(result.changed).toEqual([
			{
				text: "Improved resilience when structured changelog output is truncated.",
				evidenceNodeIds: [
					"08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c",
					"66b59f5f57c6754fd6467fee1fcc7e9b9ed224ad1b2bb898a7380e557a7f6218"
				]
			}
		])
		expect(result.internalTooling).toEqual([
			{
				text: "Added regression tests for compact editorial evidence refs.",
				evidenceNodeIds: ["8c7147a9bc815fa0031648fee857808261876e0d06424d9fdc51cee01422999b"]
			}
		])

		const userContent = azureChatCompletionWithMetaMock.mock.calls[0]?.[1]?.messages?.[1]?.content
		expect(userContent).toContain("Evidence index (compact refs; metadata only; no patch text):")
		expect(userContent).toContain("ref: E1")
		expect(userContent).toContain("ref: E2")
		expect(userContent).toContain("ref: E3")
		expect(userContent).not.toContain("08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c")
		expect(userContent).toContain("Use the minimum evidenceNodeIds needed")
	})

	it("keeps semantic notes compact and strips echoed evidence citations", async () => {
		azureChatCompletionWithMetaMock
			.mockResolvedValueOnce({
				content: JSON.stringify({
					requestHunkIds: [],
					requestFileSnippets: [],
					requestSnippetsAround: [],
					requestFileSearches: [],
					requestRepoPathSearches: [],
					requestRepoSearches: [],
					requestRepoFileLists: [],
					requestRepoFileMeta: [],
					done: true
				}),
				finishReason: null,
				usage: null
			})
			.mockResolvedValueOnce({
				content: JSON.stringify({
					notes: [
						"BREAKING: Replaced McpAcknowledgeResponse with AcknowledgeResponse. (evidence: 08d5867aa1bce1bc2510b869073dc5c64c8dccd27c519b5d78d05d81e9793c6c, 66b59f5f57c6754fd6467fee1fcc7e9b9ed224ad1b2bb898a7380e557a7f6218)",
						"Added admin and knowledge APIs. (evidenceNodeIds: 8c7147a9bc815fa0031648fee857808261876e0d06424d9fdc51cee01422999b)",
						"Added admin and knowledge APIs. (evidenceNodeIds: 8c7147a9bc815fa0031648fee857808261876e0d06424d9fdc51cee01422999b)"
					]
				}),
				finishReason: null,
				usage: null
			})

		const client = createAzureOpenAILLMClient()
		const result = await client.pass2Semantic(makeSemanticInput(), semanticTools)

		expect(result.notes).toEqual([
			"BREAKING: Replaced McpAcknowledgeResponse with AcknowledgeResponse.",
			"Added admin and knowledge APIs."
		])

		const finalMessages = azureChatCompletionWithMetaMock.mock.calls[1]?.[1]?.messages ?? []
		const finalUserContent = finalMessages[finalMessages.length - 1]?.content
		expect(finalUserContent).toContain("These are intermediate notes for a later editorial pass")
		expect(finalUserContent).toContain("Prefer at most 8 notes total")
		expect(finalUserContent).toContain("Do NOT include evidence IDs, hunk IDs, hashes, file paths")
	})
})
