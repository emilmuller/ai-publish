import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runPrepublishPipeline } from "../src/pipeline/runPrepublishPipeline"

describe("prepublish pipeline", () => {
	test("writes outputs and bumps manifest version (no commit/tag)", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a previous version tag commit with a package.json.
		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"add package"
		)
		await commitChange(dir, "config.yml", "name: base\n", "add config base")

		// Seed an existing legacy changelog as part of the base.
		await commitChange(
			dir,
			"CHANGELOG.md",
			["# Changelog (4b825dc642cb6eb9a060e54bf8d69288fbee4904..v1.2.3)", "", "- Initial release", ""].join("\n"),
			"seed changelog"
		)
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", tagCommit], { cwd: dir })

		// Make a user-visible change after the tag (patch bump).
		await commitChange(dir, "config.yml", "name: changed\n", "change config")
		const headBefore = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		const res = await runPrepublishPipeline({
			cwd: dir,
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.predictedTag).toBe("v1.2.4")
		expect(res.bumpType).toBe("patch")

		const headAfter = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		expect(headAfter).toBe(headBefore)

		// Tag should NOT exist yet.
		await expect(
			runGitOrThrow(["rev-parse", "-q", "--verify", "refs/tags/v1.2.4"], { cwd: dir })
		).rejects.toBeDefined()

		// package.json should be updated.
		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
		expect(pkg.version).toBe("1.2.4")

		// Changelog should contain the new version section (Keep a Changelog style).
		const changelog = await readFile(join(dir, "CHANGELOG.md"), "utf8")
		expect(changelog).toContain("# Changelog")
		expect(changelog).toMatch(/## \[1\.2\.4\] - \d{4}-\d{2}-\d{2}/)
		// Existing history should be preserved below.
		expect(changelog).toContain("## [1.2.3]")

		// Release notes should be written under release-notes/v1.2.4.md.
		const rnPath = join(dir, "release-notes", "v1.2.4.md")
		const releaseNotes = await readFile(rnPath, "utf8")
		expect(releaseNotes).toContain("## v1.2.4\n")
		expect(releaseNotes).toContain("### Highlights")
	}, 60_000)

	test("no tags: infers previousVersion from manifest and produces correct next version", async () => {
		const { dir } = await makeTempGitRepo()

		// Seed a public API file before the version-setting commit.
		await commitChange(dir, "src/public/api.ts", "export const foo = 0\n", "seed public api")

		// Establish the current published version in the manifest, but do NOT tag.
		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"set version 1.2.3"
		)

		// User-visible patch change after the version commit.
		await commitChange(dir, "src/public/api.ts", "export const foo = 1\n", "public change")

		const res = await runPrepublishPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		expect(res.previousTag).toBeNull()
		expect(res.previousVersion).toBe("1.2.3")
		expect(res.bumpType).toBe("patch")
		expect(res.predictedTag).toBe("v1.2.4")

		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
		expect(pkg.version).toBe("1.2.4")
	})

	test("dotnet: infers public surface from csproj directory", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a previous version tag commit with a csproj in a conventional project directory.
		await commitChange(
			dir,
			"MyLib/MyLib.csproj",
			[
				"<Project Sdk=\"Microsoft.NET.Sdk\">",
				"  <PropertyGroup>",
				"    <TargetFramework>net8.0</TargetFramework>",
				"    <Version>1.0.0</Version>",
				"  </PropertyGroup>",
				"</Project>",
				""
			].join("\n"),
			"add csproj"
		)
		await commitChange(dir, "MyLib/Foo.cs", "namespace MyLib; public static class Foo { public static int X = 0; }\n", "seed code")

		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.0.0", tagCommit], { cwd: dir })

		// User-visible code fix after the tag.
		await commitChange(dir, "MyLib/Foo.cs", "namespace MyLib; public static class Foo { public static int X = 1; }\n", "fix bug")

		const res = await runPrepublishPipeline({
			cwd: dir,
			llmClient: makeDeterministicTestLLMClient(),
			manifest: { type: "dotnet", path: "MyLib/MyLib.csproj", write: true }
		})

		expect(res.previousVersion).toBe("1.0.0")
		expect(res.bumpType).toBe("patch")
		expect(res.predictedTag).toBe("v1.0.1")

		const updated = await readFile(join(dir, "MyLib", "MyLib.csproj"), "utf8")
		expect(updated).toContain("<Version>1.0.1</Version>")
	}, 60_000)
})
