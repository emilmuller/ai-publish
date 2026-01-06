import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { indexDiff, getDiffHunks, getDiffSummary } from "../src"
import { readFile } from "node:fs/promises"
import { writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join } from "node:path"

async function runGit(cwd: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
		let err = ""
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (c: string) => (err += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => {
			if ((code ?? 0) !== 0) return reject(new Error(`git ${args.join(" ")} failed\n${err}`))
			resolve()
		})
	})
}

describe("diff indexing", () => {
	test("indexes hunks and retrieves by id", async () => {
		const repo = await makeTempGitRepo()
		const base = (await getDiffSummary("HEAD", { cwd: repo.dir })).baseSha // resolves

		// Create a new commit to diff against base.
		await commitChange(repo.dir, "a.txt", "hello\nworld\n", "add world")

		const res = await indexDiff({
			base,
			cwd: repo.dir,
			limits: { maxHunkBytes: 10_000, maxTotalHunkBytes: 1_000_000 }
		})

		expect(res.summary.files.length).toBeGreaterThan(0)
		expect(res.summary.totalHunks).toBeGreaterThan(0)

		const file = res.summary.files.find((f) => f.path === "a.txt")
		expect(file).toBeTruthy()

		// Read manifest to get hunk IDs deterministically.
		const manifestText = await readFile(res.manifestPath, "utf8")
		const manifest = JSON.parse(manifestText) as { files: Array<{ path: string; hunkIds: string[] }> }
		const hunkIds = manifest.files.find((x) => x.path === "a.txt")?.hunkIds ?? []

		const hunks = await getDiffHunks({ base, cwd: repo.dir, hunkIds })

		expect(hunks.length).toBeGreaterThan(0)
		expect(hunks[0]?.id).toMatch(/^[0-9a-f]{64}$/)
		expect(hunks[0]?.filePath).toBe("a.txt")
		expect(hunks[0]?.header.startsWith("@@ ")).toBe(true)
	})

	test("rename-only diffs produce a meta evidence hunk", async () => {
		const repo = await makeTempGitRepo()
		const base = (await getDiffSummary("HEAD", { cwd: repo.dir })).baseSha

		// Rename without content changes.
		await runGit(repo.dir, ["mv", "a.txt", "b.txt"])
		await runGit(repo.dir, ["commit", "-am", "rename a to b"])

		const res = await indexDiff({ base, cwd: repo.dir })
		const manifestText = await readFile(res.manifestPath, "utf8")
		const manifest = JSON.parse(manifestText) as {
			files: Array<{ path: string; changeType: string; hunkIds: string[] }>
		}
		const renamed = manifest.files.find((f) => f.path === "b.txt")
		expect(renamed?.changeType).toBe("rename")
		expect((renamed?.hunkIds ?? []).length).toBeGreaterThan(0)

		const hunks = await getDiffHunks({ base, cwd: repo.dir, hunkIds: renamed?.hunkIds ?? [] })
		expect(hunks[0]?.header).toBe("@@ meta @@")
	})

	test("binary diffs produce a meta evidence hunk", async () => {
		const repo = await makeTempGitRepo()
		const base = (await getDiffSummary("HEAD", { cwd: repo.dir })).baseSha

		// Add a binary file (no textual hunks expected).
		const binaryPath = join(repo.dir, "bin.dat")
		await writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 0, 255, 10, 13, 0]))
		await runGit(repo.dir, ["add", "bin.dat"])
		await runGit(repo.dir, ["commit", "-m", "add binary"])

		const res = await indexDiff({ base, cwd: repo.dir })
		const manifestText = await readFile(res.manifestPath, "utf8")
		const manifest = JSON.parse(manifestText) as {
			files: Array<{ path: string; isBinary: boolean; hunkIds: string[] }>
		}
		const bin = manifest.files.find((f) => f.path === "bin.dat")
		expect(bin?.isBinary).toBe(true)
		expect((bin?.hunkIds ?? []).length).toBeGreaterThan(0)

		const hunks = await getDiffHunks({ base, cwd: repo.dir, hunkIds: bin?.hunkIds ?? [] })
		expect(hunks[0]?.header).toBe("@@ meta @@")
	})

	test("truncated hunks are bounded and include the marker once", async () => {
		const repo = await makeTempGitRepo()
		const base = (await getDiffSummary("HEAD", { cwd: repo.dir })).baseSha

		// Create a large change that will exceed a small maxHunkBytes.
		const huge = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n") + "\n"
		await commitChange(repo.dir, "a.txt", huge, "make a huge change")

		const res = await indexDiff({
			base,
			cwd: repo.dir,
			limits: { maxHunkBytes: 350, maxTotalHunkBytes: 50_000 }
		})

		const manifestText = await readFile(res.manifestPath, "utf8")
		const manifest = JSON.parse(manifestText) as { files: Array<{ path: string; hunkIds: string[] }> }
		const hunkIds = manifest.files.find((x) => x.path === "a.txt")?.hunkIds ?? []
		expect(hunkIds.length).toBeGreaterThan(0)

		const hunks = await getDiffHunks({ base, cwd: repo.dir, hunkIds })
		expect(hunks.length).toBeGreaterThan(0)
		const first = hunks[0]!
		expect(first.isTruncated).toBe(true)

		const markerCount = first.lines.filter((l) => l.includes("truncated hunk (ai-publish)")).length
		expect(markerCount).toBe(1)

		// The stored hunk file should be small when maxHunkBytes is small.
		expect(first.byteLength ?? 0).toBeLessThan(4096)
	})
})
