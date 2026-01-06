import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import type { LLMClient, SemanticTools } from "../src/llm/types"
import { isTruthyEnv } from "./llmEvalHelpers"

describe("Integration: Azure detects breaking change via repo context (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"flags a breaking public API change when only an internal module changes",
		async () => {
			const { dir } = await makeTempGitRepo()

			// Base: public entrypoint re-exports a function + its options type from an internal module.
			await commitChange(
				dir,
				"src/index.ts",
				[
					"// Public entrypoint",
					"export { configure } from './internal/configure'",
					"export type { ConfigureOptions } from './internal/configure'"
				].join("\n") + "\n",
				"add public entrypoint"
			)

			await commitChange(
				dir,
				"src/internal/configure.ts",
				[
					"// Internal module",
					"/** @internal */",
					"export type ConfigureOptions = { timeoutMs?: number }",
					"export function configure(_opts: ConfigureOptions): void { /* noop */ }",
					""
				].join("\n"),
				"add internal configure"
			)

			await commitChange(
				dir,
				"src/consumer.ts",
				["import { configure } from './index'", "configure({})", ""].join("\n"),
				"add consumer"
			)

			const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v0.0.0", base], { cwd: dir })

			// Change: only internal file changes. The diff looks innocuous (one character),
			// but because ConfigureOptions is exported from src/index.ts, this is a breaking public API change.
			await commitChange(
				dir,
				"src/internal/configure.ts",
				[
					"// Internal module",
					"/** @internal */",
					"export type ConfigureOptions = { timeoutMs: number }",
					"export function configure(_opts: ConfigureOptions): void { /* noop */ }",
					""
				].join("\n"),
				"make timeoutMs required"
			)

			const head = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v1.0.0", head], { cwd: dir })

			const azure = createAzureOpenAILLMClient()

			let sawIndexTsContext = false
			function markIfIndexPath(path: string): void {
				if (path.replace(/\\/g, "/") === "src/index.ts") sawIndexTsContext = true
			}

			const llmClient: LLMClient = {
				pass1Mechanical: azure.pass1Mechanical,
				pass2Semantic: async (input, tools: SemanticTools) => {
					const wrapped: SemanticTools = {
						...tools,
						getRepoFileSnippets: async (reqs) => {
							for (const r of reqs) markIfIndexPath(r.path)
							return await tools.getRepoFileSnippets(reqs)
						},
						getRepoSnippetAround: async (reqs) => {
							for (const r of reqs) markIfIndexPath(r.path)
							return await tools.getRepoSnippetAround(reqs)
						},
						searchRepoFiles: async (reqs) => {
							for (const r of reqs) markIfIndexPath(r.path)
							return await tools.searchRepoFiles(reqs)
						},
						searchRepoText: async (reqs) => {
							const out = await tools.searchRepoText(reqs)
							for (const r of out) {
								if (r.matches.some((m) => m.path.replace(/\\/g, "/") === "src/index.ts")) {
									sawIndexTsContext = true
								}
							}
							return out
						},
						searchRepoPaths: async (reqs) => {
							const out = await tools.searchRepoPaths(reqs)
							for (const r of out) {
								if (r.paths?.some((p) => p.replace(/\\/g, "/") === "src/index.ts"))
									sawIndexTsContext = true
							}
							return out
						}
					}
					return await azure.pass2Semantic(input, wrapped)
				},
				pass3Editorial: azure.pass3Editorial,
				pass3ReleaseNotes: azure.pass3ReleaseNotes,
				pass3VersionBump: azure.pass3VersionBump
			}

			const res = await runChangelogPipeline({
				base,
				baseLabel: "v0.0.0",
				headLabel: "v1.0.0",
				cwd: dir,
				llmClient
			})

			// eslint-disable-next-line no-console
			console.log("\n--- AZURE CHANGELOG MARKDOWN (breaking-via-context) ---\n" + res.markdown + "\n")

			expect(res.markdown).toMatch(/# Changelog/)

			expect(
				sawIndexTsContext,
				"Expected the semantic pass to inspect src/index.ts via bounded repo context"
			).toBe(true)

			// The key property: the only diff is in an internal file, but the change is breaking because it changes
			// a type that is re-exported from src/index.ts as public API.
			expect(
				res.model.breakingChanges.length,
				`Expected a breaking change, got: ${JSON.stringify(res.model, null, 2)}`
			).toBeGreaterThan(0)

			const internalNode = Object.values(res.model.evidence).find(
				(e) => e.filePath === "src/internal/configure.ts"
			)
			expect(internalNode, "Expected evidence node for src/internal/configure.ts").toBeTruthy()

			const breakingEvidenceIds = new Set(res.model.breakingChanges.flatMap((b) => b.evidenceNodeIds))
			expect(
				breakingEvidenceIds.has(internalNode!.id),
				"Expected breaking change to cite src/internal/configure.ts evidence"
			).toBe(true)

			// Optional: try to ensure the output mentions public impact (not just internal types).
			const breakingText = res.model.breakingChanges.map((b) => b.text).join("\n")
			expect(/ConfigureOptions|configure|src\/index\.ts|public/i.test(breakingText)).toBe(true)
		},
		180_000
	)
})
