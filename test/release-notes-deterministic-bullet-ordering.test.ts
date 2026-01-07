import { describe, expect, test } from "vitest"
import type { LLMClient } from "../src/llm/types"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"

describe("release notes determinism", () => {
	test("markdown is stable even if the LLM returns bullets in a different order", async () => {
		const repo = await makeTempGitRepo()
		const base = await commitChange(repo.dir, "noop.txt", "noop\n", "noop")

		// Create several user-facing surfaces so release notes produce multiple bullets.
		await commitChange(repo.dir, "src/index.ts", "export const api = 1\n", "update public api")
		await commitChange(repo.dir, "package.json", '{\n  "name": "fixture"\n}\n', "update config")
		await commitChange(repo.dir, "README.md", "# Fixture\n\nHello\n", "update docs")
		await commitChange(repo.dir, "scripts/release.sh", "echo release\n", "update scripts")

		const baseClient = makeDeterministicTestLLMClient()

		const reversedClient: LLMClient = {
			...baseClient,
			async pass3ReleaseNotes(input) {
				const out = await baseClient.pass3ReleaseNotes(input)
				const lines = out.markdown.replace(/\r\n/g, "\n").split("\n")
				const headerIdx = lines.findIndex((l) => l.trim() === "### Highlights")
				if (headerIdx !== -1) {
					const before = lines.slice(0, headerIdx + 1)
					const bullets = lines
						.slice(headerIdx + 1)
						.filter((l) => l.trim().startsWith("- "))
						.reverse()
					return {
						markdown: [...before, ...bullets].join("\n"),
						evidenceNodeIds: [...out.evidenceNodeIds].reverse()
					}
				}
				return { markdown: out.markdown, evidenceNodeIds: [...out.evidenceNodeIds].reverse() }
			}
		}

		const normal = await runReleaseNotesPipeline({
			base,
			cwd: repo.dir,
			llmClient: baseClient,
			headLabel: "v0.0.1",
			commitContext: { mode: "none" }
		})

		const reversed = await runReleaseNotesPipeline({
			base,
			cwd: repo.dir,
			llmClient: reversedClient,
			headLabel: "v0.0.1",
			commitContext: { mode: "none" }
		})

		expect(reversed.markdown).toBe(normal.markdown)
	})
})
