import { describe, expect, test } from "vitest"

import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { getRepoSnippetAround } from "../src/repo/getRepoSnippetAround"

function textLines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
}

describe("getRepoSnippetAround", () => {
	test("returns a snippet centered around the requested line", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "src/a.txt", textLines(50), "add a")
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		const out = await getRepoSnippetAround({
			cwd: dir,
			ref: headSha,
			requests: [{ path: "src/a.txt", lineNumber: 10, contextLines: 2 }],
			maxTotalBytes: 64 * 1024,
			maxSnippetBytes: 8 * 1024,
			maxSnippetLines: 50,
			maxContextLines: 200
		})

		expect(out).toHaveLength(1)
		expect(out[0].ref).toBe(headSha)
		expect(out[0].requestedLine).toBe(10)
		expect(out[0].contextLines).toBe(2)
		expect(out[0].lines).toEqual(["line 8", "line 9", "line 10", "line 11", "line 12"])
	})

	test("rejects path traversal", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "x.txt", "ok\n", "add x")
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await expect(
			getRepoSnippetAround({
				cwd: dir,
				ref: headSha,
				requests: [{ path: "../secrets.txt", lineNumber: 1, contextLines: 5 }],
				maxTotalBytes: 64 * 1024,
				maxSnippetBytes: 8 * 1024,
				maxSnippetLines: 50,
				maxContextLines: 200
			})
		).rejects.toThrow(/Invalid path/i)
	})
})
