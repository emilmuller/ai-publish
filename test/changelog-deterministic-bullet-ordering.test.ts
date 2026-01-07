import { describe, expect, test } from "vitest"
import type { LLMClient } from "../src/llm/types"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"

describe("changelog determinism", () => {
	test("markdown is stable even if the LLM returns bullets in a different order", async () => {
		const repo = await makeTempGitRepo()

		// Use the initial commit as the base.
		const base = await commitChange(repo.dir, "noop.txt", "noop\n", "noop")

		// Create several distinct surfaces so sort keys differ.
		await commitChange(repo.dir, "src/index.ts", "export const api = 1\n", "update public api")
		await commitChange(repo.dir, "package.json", '{\n  "name": "fixture"\n}\n', "update config")
		await commitChange(repo.dir, "README.md", "# Fixture\n\nHello\n", "update docs")

		const baseClient = makeDeterministicTestLLMClient()

		const reversedClient: LLMClient = {
			...baseClient,
			async pass3Editorial(input) {
				const model = await baseClient.pass3Editorial(input)
				return {
					...model,
					breakingChanges: [...model.breakingChanges].reverse(),
					added: [...model.added].reverse(),
					changed: [...model.changed].reverse(),
					fixed: [...model.fixed].reverse(),
					removed: [...model.removed].reverse(),
					internalTooling: [...model.internalTooling].reverse(),
					evidence: {}
				}
			}
		}

		const normal = await runChangelogPipeline({
			base,
			cwd: repo.dir,
			llmClient: baseClient,
			headLabel: "v0.0.1",
			commitContext: { mode: "none" }
		})

		const reversed = await runChangelogPipeline({
			base,
			cwd: repo.dir,
			llmClient: reversedClient,
			headLabel: "v0.0.1",
			commitContext: { mode: "none" }
		})

		expect(reversed.markdown).toBe(normal.markdown)
	})
})
