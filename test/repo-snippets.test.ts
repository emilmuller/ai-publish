import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { getRepoFileSnippets } from "../src/repo/getRepoFileSnippets"

function textLines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
}

describe("repo context snippets", () => {
	test("returns bounded line ranges from HEAD snapshot", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "src/a.txt", textLines(50), "add a")

		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		const snippets = await getRepoFileSnippets({
			cwd: dir,
			ref: headSha,
			requests: [{ path: "src/a.txt", startLine: 10, endLine: 12 }],
			maxTotalBytes: 64 * 1024,
			maxSnippetBytes: 8 * 1024,
			maxSnippetLines: 50
		})

		expect(snippets).toHaveLength(1)
		expect(snippets[0]!.lines).toEqual(["line 10", "line 11", "line 12"])
		expect(snippets[0]!.ref).toBe(headSha)
	})

	test("rejects path traversal", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "x.txt", "ok\n", "add x")
		const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await expect(
			getRepoFileSnippets({
				cwd: dir,
				ref: headSha,
				requests: [{ path: "../secrets.txt", startLine: 1, endLine: 5 }],
				maxTotalBytes: 64 * 1024,
				maxSnippetBytes: 8 * 1024,
				maxSnippetLines: 50
			})
		).rejects.toThrow(/Invalid path/i)
	})
})
