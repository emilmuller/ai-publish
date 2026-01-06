import { describe, expect, test } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { getDiffSummary, indexDiff, getDiffHunks } from "../src"

describe("getDiffHunks validation", () => {
	test("rejects malformed stored hunk files", async () => {
		const repo = await makeTempGitRepo()
		const base = (await getDiffSummary("HEAD", { cwd: repo.dir })).baseSha

		await commitChange(repo.dir, "a.txt", "hello\nworld\n", "change a")
		const indexed = await indexDiff({ base, cwd: repo.dir })

		const manifestText = await readFile(indexed.manifestPath, "utf8")
		const manifest = JSON.parse(manifestText) as { files: Array<{ path: string; hunkIds: string[] }> }
		const hunkId = manifest.files.find((f) => f.path === "a.txt")?.hunkIds?.[0]
		expect(hunkId).toMatch(/^[0-9a-f]{64}$/)

		// Corrupt the stored hunk file and ensure retrieval fails safely.
		const hunkPath = join(indexed.indexDir, "hunks", `${hunkId}.patch`)
		await writeFile(hunkPath, "not-a-valid-hunk\n", "utf8")

		await expect(getDiffHunks({ base, cwd: repo.dir, hunkIds: [hunkId!] })).rejects.toThrow(
			/Invalid hunk file format/i
		)
	})
})
