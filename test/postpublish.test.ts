import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange, makeBareRemoteAndAddOrigin, gitShowRef } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runPrepublishPipeline } from "../src/pipeline/runPrepublishPipeline"
import { runPostpublishPipeline } from "../src/pipeline/runPostpublishPipeline"

describe("postpublish pipeline", () => {
	test("pushes branch + tag only after publish succeeds", async () => {
		const { dir } = await makeTempGitRepo()
		const { remoteDir } = await makeBareRemoteAndAddOrigin(dir)

		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"add package"
		)
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", tagCommit], { cwd: dir })
		await commitChange(dir, "config.yml", "name: changed\n", "change config")

		const pre = await runPrepublishPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		expect(pre.predictedTag).toBe("v1.2.4")

		// Prepublish should NOT create the tag.
		await expect(
			runGitOrThrow(["rev-parse", "-q", "--verify", "refs/tags/v1.2.4"], { cwd: dir })
		).rejects.toBeDefined()

		const post = await runPostpublishPipeline({
			cwd: dir,
			remote: "origin",
			publishRunner: async () => {
				// Simulate a successful publish without network.
				return
			}
		})

		expect(post.tag).toBe("v1.2.4")

		const remoteTag = await gitShowRef(remoteDir, "refs/tags/v1.2.4")
		expect(remoteTag.found).toBe(true)

		const remoteBranch = await gitShowRef(remoteDir, `refs/heads/${post.branch}`)
		expect(remoteBranch.found).toBe(true)
	}, 60_000)

	test("does not push if publish fails", async () => {
		const { dir } = await makeTempGitRepo()
		const { remoteDir } = await makeBareRemoteAndAddOrigin(dir)

		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"add package"
		)
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", tagCommit], { cwd: dir })
		await commitChange(dir, "config.yml", "name: changed\n", "change config")

		await runPrepublishPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		await expect(
			runGitOrThrow(["rev-parse", "-q", "--verify", "refs/tags/v1.2.4"], { cwd: dir })
		).rejects.toBeDefined()

		await expect(
			runPostpublishPipeline({
				cwd: dir,
				remote: "origin",
				publishRunner: async () => {
					throw new Error("publish failed")
				}
			})
		).rejects.toThrow(/publish failed/)

		// Should not create the tag locally on failure.
		await expect(
			runGitOrThrow(["rev-parse", "-q", "--verify", "refs/tags/v1.2.4"], { cwd: dir })
		).rejects.toBeDefined()

		const remoteTag = await gitShowRef(remoteDir, "refs/tags/v1.2.4")
		expect(remoteTag.found).toBe(false)
	}, 60_000)
})
