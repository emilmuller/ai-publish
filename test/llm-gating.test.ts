import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import type { LLMClient, SemanticTools } from "../src/llm/types"

function largeText(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n"
}

describe("LLM tool-gating", () => {
	test("semantic repo file listing is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/example.ts", "export function foo() { return 1 }\n", "add example")

		let listed = 0
		let truncated = false

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.listRepoFiles([{ pathPrefix: "src/", fileExtensions: [".ts"], maxFiles: 50 }])
				listed = res[0]?.paths?.length ?? 0
				truncated = Boolean(res[0]?.isTruncated)
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added example", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(listed).toBeGreaterThan(0)
		expect(truncated).toBe(false)
	})

	test("semantic repo path search is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/example.ts", "export function foo() { return 1 }\n", "add example")
		await commitChange(dir, "docs/example.md", "# example\n", "add docs")

		let pathCount = 0
		let truncated = false

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.searchRepoPaths([
					{ query: "example", ignoreCase: true, pathPrefix: "src/", fileExtensions: [".ts"], maxFiles: 50 }
				])
				pathCount = res[0]?.paths?.length ?? 0
				truncated = Boolean(res[0]?.isTruncated)
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added example", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(pathCount).toBeGreaterThan(0)
		expect(truncated).toBe(false)
	})

	test("semantic repo snippet-around is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/a.txt", largeText(200), "add a")

		let lineCount = 0
		let gotTruncated = false

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.getRepoSnippetAround([{ path: "src/a.txt", lineNumber: 10, contextLines: 2 }])
				lineCount = res[0]?.lines?.length ?? 0
				gotTruncated = Boolean(res[0]?.isTruncated)
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added snippet-around", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(lineCount).toBeGreaterThan(0)
		expect(gotTruncated).toBe(false)
	}, 60_000)

	test("semantic repo file meta is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/a.txt", "hello\nworld\n", "add a")

		let byteSize = 0
		let isBinary = true
		let lineCount: number | null = null

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.getRepoFileMeta([{ path: "src/a.txt" }])
				byteSize = res[0]?.byteSize ?? 0
				isBinary = Boolean(res[0]?.isBinary)
				lineCount = (res[0]?.lineCount as any) ?? null
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added file meta", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(byteSize).toBeGreaterThan(0)
		expect(isBinary).toBe(false)
		expect(lineCount).not.toBe(null)
	})

	test("semantic repo-wide search is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/example.ts", "export function foo() { return 1 }\n", "add example")

		let matchCount = 0
		let truncated = false

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.searchRepoText([
					{ query: "foo", pathPrefix: "src/", fileExtensions: [".ts"], maxResults: 10, maxFiles: 50 }
				])
				matchCount = res[0]?.matches?.length ?? 0
				truncated = Boolean(res[0]?.isTruncated)
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added example", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(matchCount).toBeGreaterThan(0)
		expect(truncated).toBe(false)
	})

	test("semantic repo search is available and bounded", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/example.ts", "export function foo() { return 1 }\n", "add example")

		let searchMatches = 0
		let searchWasTruncated = false

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(_input, tools: SemanticTools) {
				const res = await tools.searchRepoFiles([
					{ path: "src/example.ts", query: "foo", ignoreCase: false, maxResults: 5 }
				])
				searchMatches = res[0]?.matches?.length ?? 0
				searchWasTruncated = Boolean(res[0]?.isTruncated)
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added example", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(searchMatches).toBeGreaterThan(0)
		expect(searchWasTruncated).toBe(false)
	})

	test("semantic hunk retrieval is restricted to evidence-known hunk IDs", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "x.txt", "hello\nworld\n", "change x")

		const fakeId = "f".repeat(64)

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(input, tools: SemanticTools) {
				// The ID is 64-hex but should not exist in the evidence index.
				const hunks = await tools.getDiffHunks([fakeId])
				expect(hunks).toEqual([])
				return { notes: [] }
			},
			async pass3Editorial() {
				return {
					breakingChanges: [],
					added: [],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await expect(runChangelogPipeline({ base, cwd: dir, llmClient: client })).resolves.toBeDefined()
	})

	test("semantic hunk retrieval is globally budgeted", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		// Create enough large diffs to require multiple hunks.
		for (let i = 0; i < 6; i++) {
			await commitChange(dir, `f${i}.txt`, largeText(8000), `add f${i}`)
		}

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic(input, tools: SemanticTools) {
				const allHunkIds = Object.values(input.evidence)
					.flatMap((e) => e.hunkIds)
					.filter(Boolean)

				// Request hunks one-by-one until we exceed the global budget.
				for (const id of allHunkIds) {
					await tools.getDiffHunks([id])
				}
				return { notes: [] }
			},
			async pass3Editorial() {
				return {
					breakingChanges: [],
					added: [],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		// The pipeline enforces a global hunk budget by skipping/clamping retrievals
		// once the budget is exhausted, rather than failing the entire run.
		const res = await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(res.markdown).toContain("# Changelog")
		expect(res.markdown).toContain("## [Unreleased] - ")
	}, 60_000)

	test("LLM output is validated and evidence is injected", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await commitChange(dir, "src/public/x.ts", "export const x = 1\n", "change x")

		const client: LLMClient = {
			async pass1Mechanical() {
				return { notes: ["changed something"] }
			},
			async pass2Semantic() {
				return { notes: ["semantic note"] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [],
					changed: [{ text: "Updated something", evidenceNodeIds: [firstEvidenceId] }],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		const res = await runChangelogPipeline({ base, cwd: dir, llmClient: client })
		expect(Object.keys(res.model.evidence).length).toBeGreaterThan(0)
		expect(res.markdown).toContain("- Updated something")
	}, 60_000)
})
