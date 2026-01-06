import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runPrepublishPipeline } from "../src/pipeline/runPrepublishPipeline"

describe("prepublish pipeline", () => {
	test("creates release commit + annotated tag and writes outputs", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a previous version tag commit with a package.json.
		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"add package"
		)
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", tagCommit], { cwd: dir })

		// Make a user-visible change after the tag (patch bump).
		await commitChange(dir, "config.yml", "name: changed\n", "change config")

		const res = await runPrepublishPipeline({
			cwd: dir,
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.predictedTag).toBe("v1.2.4")
		expect(res.bumpType).toBe("patch")

		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		expect(headSha).toBe(res.commitSha)

		// Tag should be annotated and point at the release commit.
		const tagType = (await runGitOrThrow(["cat-file", "-t", res.predictedTag], { cwd: dir })).trim()
		expect(tagType).toBe("tag")
		const tagTarget = (await runGitOrThrow(["rev-list", "-n", "1", res.predictedTag], { cwd: dir })).trim()
		expect(tagTarget).toBe(res.commitSha)

		const tagBody = await runGitOrThrow(["cat-file", "-p", res.predictedTag], { cwd: dir })
		expect(tagBody).toMatch(/Release v1\.2\.4/)
		expect(tagBody).toMatch(/\[Changed\]/)

		// package.json should be updated.
		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
		expect(pkg.version).toBe("1.2.4")

		// Changelog entry should reference v1.2.3..v1.2.4.
		const changelog = await readFile(join(dir, "CHANGELOG.md"), "utf8")
		expect(changelog).toMatch(/Changelog \(v1\.2\.3\.\.v1\.2\.4\)/)

		// Release notes should be written under release-notes/v1.2.4.md.
		const rnPath = join(dir, "release-notes", "v1.2.4.md")
		const releaseNotes = await readFile(rnPath, "utf8")
		expect(releaseNotes).toMatch(/# Release Notes \(v1\.2\.3\.\.v1\.2\.4\)/)
	}, 60_000)
})
