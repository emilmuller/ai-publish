import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"
import { indexDiff } from "../src/diff"
import { buildEvidenceFromManifest } from "../src/changelog/evidence"
import type { DiffIndexManifest } from "../src/diff/types"

function normalizePathToken(p: string): string {
	return p.replace(/\\/g, "/")
}

function extractLikelyRepoPaths(text: string): string[] {
	const pattern = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g
	const matches = text.match(pattern) ?? []
	return [...new Set(matches.map(normalizePathToken))].sort()
}

function assertNoDiffLeakage(markdown: string): void {
	expect(markdown).not.toMatch(/\bdiff --git\b/)
	expect(markdown).not.toMatch(/^@@/m)
	expect(markdown).not.toMatch(/^\+\+\+\s+b\//m)
	expect(markdown).not.toMatch(/^---\s+a\//m)
	expect(markdown).not.toMatch(/^index\s+[0-9a-f]{7,}\b/m)
}

describe("Integration: Azure release notes quality invariants (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"includes evidence for every changed file and avoids hallucinated paths",
		async () => {
			const { dir } = await makeTempGitRepo()
			await commitChange(dir, "config.yml", "name: base\n", "add config base")
			await commitChange(dir, "old.txt", "to be removed\n", "add old file")

			const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

			await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })
			await commitChange(dir, "config.yml", "name: changed\n", "change config")
			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			// Build the expected evidence IDs deterministically from the authoritative diff index.
			const indexRes = await indexDiff({ base, cwd: dir })
			const manifestText = await readFile(indexRes.manifestPath, "utf8")
			const manifest = JSON.parse(manifestText) as DiffIndexManifest
			const expectedEvidence = buildEvidenceFromManifest(manifest)
			const expectedEvidenceIds = Object.keys(expectedEvidence).sort()

			const llmClient = createAzureOpenAILLMClient()
			const res = await runReleaseNotesPipeline({ base, cwd: dir, llmClient })

			expect(res.markdown).toMatch(/^##\s+v|^##\s+Unreleased/m)
			assertNoDiffLeakage(res.markdown)
			expect(res.releaseNotes.markdown.trim().length).toBeGreaterThan(0)
			expect(res.markdown.length).toBeLessThan(4000)

			// Quality bar for small diffs: the release notes must cite every changed file's evidence.
			const ids = res.releaseNotes.evidenceNodeIds
			const uniqueSorted = [...new Set(ids)].sort()
			expect(ids).toEqual(uniqueSorted)
			expect(uniqueSorted).toEqual(expectedEvidenceIds)

			// If the LLM mentions file paths, they must be limited to changed files.
			const allowedPaths = new Set(
				Object.values(expectedEvidence)
					.flatMap((e) => [e.filePath, e.oldPath].filter((p): p is string => typeof p === "string" && !!p))
					.map(normalizePathToken)
			)
			const mentionedPaths = extractLikelyRepoPaths(res.markdown)
			for (const p of mentionedPaths) {
				expect(allowedPaths.has(p), `Unexpected path mentioned in release notes: ${p}`).toBe(true)
			}
		},
		180_000
	)
})
