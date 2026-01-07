import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"

function normalizePathToken(p: string): string {
	return p.replace(/\\/g, "/")
}

function extractLikelyRepoPaths(text: string): string[] {
	// Heuristic: only treat tokens that look like repo file paths.
	// Keep conservative to avoid false positives.
	const pattern = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g
	const matches = text.match(pattern) ?? []
	return [...new Set(matches.map(normalizePathToken))].sort()
}

function assertNoDiffLeakage(markdown: string): void {
	// Release notes/changelog should never contain raw patch markers.
	expect(markdown).not.toMatch(/\bdiff --git\b/)
	expect(markdown).not.toMatch(/^@@/m)
	expect(markdown).not.toMatch(/^\+\+\+\s+b\//m)
	expect(markdown).not.toMatch(/^---\s+a\//m)
	expect(markdown).not.toMatch(/^index\s+[0-9a-f]{7,}\b/m)
}

describe("Integration: Azure changelog quality invariants (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"covers every evidence node and avoids hallucinated paths",
		async () => {
			const { dir } = await makeTempGitRepo()
			await commitChange(dir, "config.yml", "name: base\n", "add config base")
			await commitChange(dir, "old.txt", "to be removed\n", "add old file")

			const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

			await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })
			await commitChange(dir, "config.yml", "name: changed\n", "change config")
			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			const llmClient = createAzureOpenAILLMClient()
			const res = await runChangelogPipeline({ base, cwd: dir, llmClient })

			expect(res.markdown).toMatch(/^# Changelog\b/m)
			expect(res.markdown).toMatch(/^## \[[^\]]+\]/m)
			assertNoDiffLeakage(res.markdown)

			// Quality bar for small diffs: every changed file (evidence node) is mentioned by at least one bullet.
			const allEvidenceIds = Object.keys(res.model.evidence).sort()
			const allBullets = [
				...res.model.breakingChanges,
				...res.model.added,
				...res.model.changed,
				...res.model.fixed,
				...res.model.removed,
				...res.model.internalTooling
			]
			const referenced = new Set(allBullets.flatMap((b) => b.evidenceNodeIds))
			expect([...referenced].sort()).toEqual(allEvidenceIds)

			// Ensure bullets are non-empty, unique (case-insensitive), and not overly verbose.
			const normalized = allBullets.map((b) => b.text.trim().replace(/\s+/g, " "))
			expect(normalized.every((t) => t.length > 0)).toBe(true)
			expect(normalized.every((t) => t.length <= 240)).toBe(true)
			const dedupKey = new Set(normalized.map((t) => t.toLowerCase()))
			expect(dedupKey.size).toBe(normalized.length)

			// If the LLM mentions specific file paths, they must be limited to changed files.
			const allowedPaths = new Set(
				Object.values(res.model.evidence)
					.flatMap((e) => [e.filePath, e.oldPath].filter((p): p is string => typeof p === "string" && !!p))
					.map(normalizePathToken)
			)
			const mentionedPaths = extractLikelyRepoPaths(res.markdown)
			for (const p of mentionedPaths) {
				expect(allowedPaths.has(p), `Unexpected path mentioned in changelog: ${p}`).toBe(true)
			}
		},
		180_000
	)
})
