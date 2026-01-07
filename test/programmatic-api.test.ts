import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { generateChangelog, generateReleaseNotes } from "../src/programmatic"

function normalizeHeader(markdown: string): string {
	// Release notes still render a "(<base>..<head>)" range header.
	return markdown.replace(
		/^(#|###) (Release Notes) \((?:[0-9a-f]{7,40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.\.(?:[0-9a-f]{7,40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|HEAD)\)$/m,
		(_m, hashes: string, title: string) => `${hashes} ${title} (<base>..<head>)`
	)
}

describe("Programmatic API", () => {
	test("generateChangelog mirrors CLI params and writes outputs", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a base commit that already contains a few files.
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		await commitChange(dir, "old.txt", "to be removed\n", "add old file")
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		// Net changes (base..HEAD): delete old.txt, modify config.yml, add src/public/newApi.ts
		await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
		await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })
		await commitChange(dir, "config.yml", "name: changed\n", "change config")
		await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

		const res = await generateChangelog({
			base,
			cwd: dir,
			llm: "azure",
			outPath: "OUT_CHANGELOG.md",
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.outPath).toMatch(/OUT_CHANGELOG\.md$/i)

		const mdOnDisk = await readFile(res.outPath, "utf8")
		expect(mdOnDisk).toContain("# Changelog\n")
		expect(mdOnDisk).toContain("## [Unreleased] - ")
		expect(mdOnDisk).toContain("### Added")
		expect(mdOnDisk).toContain("- Expose foo in public API")
		expect(mdOnDisk).toContain("- Update name from 'base' to 'changed'")
		// Internal-only deletes (like old.txt) are omitted from the consumer-facing changelog.

		expect(Array.isArray((res.model as any).added)).toBe(true)
		expect(Array.isArray((res.model as any).changed)).toBe(true)
		expect((res.model as any).evidence && typeof (res.model as any).evidence).toBe("object")
	}, 40_000)

	test("generateChangelog upserts Unreleased instead of duplicating", async () => {
		const { dir } = await makeTempGitRepo()

		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(dir, "config.yml", "name: changed\n", "change config")

		await generateChangelog({
			base,
			cwd: dir,
			llm: "azure",
			outPath: "OUT_CHANGELOG.md",
			llmClient: makeDeterministicTestLLMClient()
		})

		// New change, same base.
		await commitChange(dir, "config.yml", "name: again\n", "change config again")

		await generateChangelog({
			base,
			cwd: dir,
			llm: "azure",
			outPath: "OUT_CHANGELOG.md",
			llmClient: makeDeterministicTestLLMClient()
		})

		const mdOnDisk = await readFile(join(dir, "OUT_CHANGELOG.md"), "utf8")
		const unreleasedCount = (mdOnDisk.match(/^## \[Unreleased\]/gm) ?? []).length
		expect(unreleasedCount).toBe(1)
		expect(mdOnDisk).toContain("again")
	}, 40_000)

	test("generateReleaseNotes mirrors CLI params and writes outputs", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(dir, "x.txt", "hello\nworld\n", "change x")

		const res = await generateReleaseNotes({
			base,
			cwd: dir,
			llm: "azure",
			outPath: "OUT_RELEASE.md",
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.outPath).toMatch(/OUT_RELEASE\.md$/i)

		const mdOnDisk = await readFile(res.outPath, "utf8")
		expect(mdOnDisk).toContain("## Unreleased\n")
		expect(typeof (res.releaseNotes as any).markdown).toBe("string")
		expect(Array.isArray((res.releaseNotes as any).evidenceNodeIds)).toBe(true)
	})

	test("generateReleaseNotes defaults to release-notes/<tag>.md when HEAD is tagged", async () => {
		const { dir } = await makeTempGitRepo()
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(dir, "x.txt", "hello\nworld\n", "change x")
		const head = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", head], { cwd: dir })

		const res = await generateReleaseNotes({
			base,
			cwd: dir,
			llm: "azure",
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.outPath.replace(/\\/g, "/")).toMatch(/\/release-notes\/v1\.2\.3\.md$/i)
		const mdOnDisk = await readFile(res.outPath, "utf8")
		expect(mdOnDisk).toContain("## v1.2.3\n")
	})

	test("generateReleaseNotes predicts v<nextVersion>.md when HEAD is not tagged", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a previous version tag on the base commit.
		await commitChange(dir, "base.txt", "base\n", "add base")
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.3", tagCommit], { cwd: dir })

		// Make a user-visible change after the tag; HEAD remains untagged.
		await commitChange(dir, "config.yml", "name: changed\n", "change config")

		const res = await generateReleaseNotes({
			cwd: dir,
			llm: "azure",
			llmClient: makeDeterministicTestLLMClient()
		})

		expect(res.outPath.replace(/\\/g, "/")).toMatch(/\/release-notes\/v1\.2\.4\.md$/i)
	}, 40_000)
})
