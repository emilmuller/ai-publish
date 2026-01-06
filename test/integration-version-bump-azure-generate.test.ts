import { describe, expect, test } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import semver from "semver"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { createAzureOpenAILLMClient } from "../src/llm/azureOpenAI"
import { isTruthyEnv } from "./llmEvalHelpers"
import { runVersionBumpPipeline } from "../src/pipeline/runVersionBumpPipeline"

describe("Integration: Azure bumps version (local-only)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_GENERATE === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"updates package.json using previous version tag commit as base",
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

			// eslint-disable-next-line no-console
			console.log("\n--- AZURE VERSION BUMP ---\n" + JSON.stringify(res, null, 2) + "\n")

			expect(semver.valid(res.previousVersion)).toBeTruthy()
			expect(semver.valid(res.nextVersion)).toBeTruthy()
			if (res.bumpType !== "none") {
				expect(semver.gt(res.nextVersion, res.previousVersion)).toBe(true)
				expect(res.updated).toBe(true)
			}
			expect(res.justification.length).toBeGreaterThan(0)

			const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
			if (res.bumpType !== "none") {
				expect(pkg.version).toBe(res.nextVersion)
			}
		},
		240_000
	)
})
