import { describe, expect, test } from "vitest"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"
import { runVersionBumpPipeline } from "../src/pipeline/runVersionBumpPipeline"

function assertNoDiffLeakage(text: string): void {
	expect(text).not.toMatch(/\bdiff --git\b/)
	expect(text).not.toMatch(/^@@/m)
	expect(text).not.toMatch(/^\+\+\+\s+b\//m)
	expect(text).not.toMatch(/^---\s+a\//m)
	expect(text).not.toMatch(/^index\s+[0-9a-f]{7,}\b/m)
}

describe("Integration: Azure version bump quality invariants (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"justification is non-empty and does not leak raw diff markers",
		async () => {
			const { dir } = await makeTempGitRepo()

			await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }, null, 2) + "\n")
			await runGitOrThrow(["add", "package.json"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "add package"], { cwd: dir })

			const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v1.2.3-beta.1", tagCommit], { cwd: dir })

			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			const llmClient = createAzureOpenAILLMClient()
			const res = await runVersionBumpPipeline({ cwd: dir, llmClient })

			expect(res.justification.trim().length).toBeGreaterThan(0)
			assertNoDiffLeakage(res.justification)
		},
		240_000
	)
})
