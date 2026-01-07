import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"

describe("Integration: Azure generates release notes (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"prints Azure-written release notes markdown",
		async () => {
			const { dir } = await makeTempGitRepo()
			await commitChange(dir, "config.yml", "name: base\n", "add config base")
			await commitChange(dir, "old.txt", "to be removed\n", "add old file")

			const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v0.0.0", base], { cwd: dir })

			await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })
			await commitChange(dir, "config.yml", "name: changed\n", "change config")
			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			const head = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v0.1.0", head], { cwd: dir })

			const llmClient = createAzureOpenAILLMClient()
			const res = await runReleaseNotesPipeline({
				base,
				baseLabel: "v0.0.0",
				headLabel: "v0.1.0",
				cwd: dir,
				llmClient
			})

			// eslint-disable-next-line no-console
			console.log("\n--- AZURE RELEASE NOTES MARKDOWN ---\n" + res.markdown + "\n")

			expect(res.markdown).toMatch(/^##\s+(v\d+\.\d+\.\d+|Unreleased)\b/m)
			expect(res.releaseNotes.markdown.trim().length).toBeGreaterThan(0)
		},
		180_000
	)
})
