import { describe, expect, test } from "vitest"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo } from "./gitFixture"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runGitOrThrow } from "../src/git/runGit"

describe("release notes hunk budget chunking", () => {
	test("does not fail when the model requests more hunks than fit in the remaining byte budget", async () => {
		const repo = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: repo.dir })).trim()

		// Create enough large hunks that requesting them all at once would exceed
		// the pipeline's remaining hunk budget (256 KiB).
		//
		// Keep this fast by committing all files in one git commit.
		const bigLine = "x".repeat(300)
		const bigBody = Array.from({ length: 250 }, () => bigLine).join("\n") + "\n"
		const fileCount = 6
		for (let i = 0; i < fileCount; i++) {
			await writeFile(join(repo.dir, `big-${i}.txt`), bigBody, "utf8")
		}
		await runGitOrThrow(["add", "."], { cwd: repo.dir })
		await runGitOrThrow(["commit", "-m", "add big files"], { cwd: repo.dir })

		const llmClient = makeDeterministicTestLLMClient()

		await expect(
			runReleaseNotesPipeline({
				base,
				cwd: repo.dir,
				llmClient,
				// Keep commit context off to reduce unrelated variability.
				commitContext: { mode: "none" }
			})
		).resolves.toMatchObject({
			markdown: expect.any(String),
			releaseNotes: {
				markdown: expect.any(String),
				evidenceNodeIds: expect.any(Array)
			}
		})
	}, 45_000)
})
