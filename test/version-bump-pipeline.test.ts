import { describe, expect, test } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runVersionBumpPipeline } from "../src/pipeline/runVersionBumpPipeline"

describe("Version bump pipeline", () => {
	test("internal-only changes produce bumpType none and do not modify package.json", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish package.json and tag a prerelease version.
		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "x", version: "999.0.0" }, null, 2) + "\n",
			"add package"
		)
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3-beta.1", tagCommit], { cwd: dir })

		// Internal-only change since tag.
		await commitChange(dir, "src/internal/impl.ts", "export const x = 1\n", "internal change")

		const before = await readFile(join(dir, "package.json"), "utf8")
		const res = await runVersionBumpPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		const after = await readFile(join(dir, "package.json"), "utf8")

		expect(res.previousVersion).toBe("1.2.3-beta.1")
		expect(res.bumpType).toBe("none")
		expect(res.nextVersion).toBe("1.2.3-beta.1")
		expect(res.manifestType).toBe("npm")
		expect(res.updated).toBe(false)
		expect(after).toBe(before)
	})

	test("patch changes on a prerelease version increment prerelease stream and update package.json", async () => {
		const { dir } = await makeTempGitRepo()

		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }, null, 2) + "\n")
		await runGitOrThrow(["add", "package.json"], { cwd: dir })
		await runGitOrThrow(["commit", "-m", "add package"], { cwd: dir })

		// Create a public API file before tagging, so later changes are a modify (patch), not an add (minor).
		await commitChange(dir, "src/public/api.ts", "export const foo = 0\n", "seed public api")

		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3-beta.1", tagCommit], { cwd: dir })

		// Public API change => bumpType patch under our deterministic model.
		await commitChange(dir, "src/public/api.ts", "export const foo = 1\n", "public change")

		// Make package.json intentionally wrong; bump must not trust it.
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "999.0.0" }, null, 2) + "\n")

		const res = await runVersionBumpPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		expect(res.previousVersion).toBe("1.2.3-beta.1")
		expect(res.bumpType).toBe("patch")
		expect(res.nextVersion).toBe("1.2.3-beta.2")
		expect(res.manifestType).toBe("npm")
		expect(res.updated).toBe(true)

		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
		expect(pkg.version).toBe("1.2.3-beta.2")
	}, 60_000)

	test("no tags: infers previousVersion from package.json and base from manifest history", async () => {
		const { dir } = await makeTempGitRepo()

		// Seed a public API file before the version-setting commit, so later edits are a patch.
		await commitChange(dir, "src/public/api.ts", "export const foo = 0\n", "seed public api")

		// Set the package version (this is the commit we should infer as base when no tags exist).
		const baseCommit = await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "x", version: "5.2.0" }, null, 2) + "\n",
			"set version 5.2.0"
		)

		// User-visible change after the version commit.
		await commitChange(dir, "src/public/api.ts", "export const foo = 1\n", "public change")

		const res = await runVersionBumpPipeline({ cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		expect(res.previousTag).toBeNull()
		expect(res.previousVersion).toBe("5.2.0")
		expect(res.base).toBe(baseCommit)
		expect(res.bumpType).toBe("patch")
		expect(res.nextVersion).toBe("5.2.1")

		const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as any
		expect(pkg.version).toBe("5.2.1")
	})
})
