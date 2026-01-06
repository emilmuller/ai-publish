import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"

describe("Integration: Azure generates changelog (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"prints Azure-written changelog markdown",
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
			const res = await runChangelogPipeline({
				base,
				baseLabel: "v0.0.0",
				headLabel: "v0.1.0",
				cwd: dir,
				llmClient
			})

			// eslint-disable-next-line no-console
			console.log("\n--- AZURE CHANGELOG MARKDOWN ---\n" + res.markdown + "\n")

			expect(res.markdown).toMatch(/# Changelog/)
			expect(res.model.added.length + res.model.changed.length + res.model.removed.length).toBeGreaterThan(0)
		},
		180_000
	)
})
