import { describe, expect, test } from "vitest"

import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { getRepoFileMeta } from "../src/repo/getRepoFileMeta"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

function textLines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
}

describe("getRepoFileMeta", () => {
	test("returns byte size and line count for small text files", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "src/a.txt", textLines(5), "add a")
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		const out = await getRepoFileMeta({
			cwd: dir,
			ref: headSha,
			requests: [{ path: "src/a.txt" }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 50,
			maxProbeBytesPerFile: 8 * 1024,
			maxLineCountBytesPerFile: 64 * 1024
		})

		expect(out).toHaveLength(1)
		expect(out[0].path).toBe("src/a.txt")
		expect(out[0].ref).toBe(headSha)
		expect(out[0].byteSize).toBeGreaterThan(0)
		expect(out[0].isBinary).toBe(false)
		expect(out[0].lineCount).toBe(5)
		expect(out[0].lineCountIsTruncated).toBe(false)
	})

	test("detects binary blobs and does not return line counts", async () => {
		const { dir } = await makeTempGitRepo()

		// Write a binary file containing a NUL byte, then commit.
		await runGitOrThrow(["checkout", "-b", "bin"], { cwd: dir })
		await writeFile(join(dir, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]))
		await runGitOrThrow(["add", "bin.dat"], { cwd: dir })
		await runGitOrThrow(["commit", "-m", "add binary"], { cwd: dir })
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		const out = await getRepoFileMeta({
			cwd: dir,
			ref: headSha,
			requests: [{ path: "bin.dat" }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 50,
			maxProbeBytesPerFile: 8 * 1024,
			maxLineCountBytesPerFile: 64 * 1024
		})

		expect(out[0].isBinary).toBe(true)
		expect(out[0].lineCount).toBe(null)
		expect(out[0].lineCountIsTruncated).toBe(true)
	})

	test("rejects path traversal", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "ok.txt", "hello\n", "add ok")
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await expect(
			getRepoFileMeta({
				cwd: dir,
				ref: headSha,
				requests: [{ path: "../secrets.txt" }],
				maxTotalBytes: 64 * 1024,
				maxFilesPerRequest: 50,
				maxProbeBytesPerFile: 8 * 1024,
				maxLineCountBytesPerFile: 64 * 1024
			})
		).rejects.toThrow(/Invalid path/i)
	})
})
