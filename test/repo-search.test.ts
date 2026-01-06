import { describe, expect, it } from "vitest"

import { searchRepoFiles } from "../src/repo/searchRepoFiles"
import { commitChange, makeTempGitRepo } from "./gitFixture"

describe("searchRepoFiles", () => {
	it("returns bounded matches with line numbers", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(
			fx.dir,
			"src/example.ts",
			[
				"export function foo() {",
				"  return 1",
				"}",
				"",
				"export function bar() {",
				"  return foo() + 1",
				"}"
			].join("\n"),
			"add example"
		)

		const out = await searchRepoFiles({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ path: "src/example.ts", query: "foo" }],
			maxTotalBytes: 64 * 1024,
			maxResultBytes: 16 * 1024,
			maxMatchesPerRequest: 50
		})

		expect(out).toHaveLength(1)
		expect(out[0].path).toBe("src/example.ts")
		expect(out[0].ref).toBe("HEAD")
		expect(out[0].query).toBe("foo")
		expect(out[0].matches.length).toBeGreaterThan(0)
		expect(out[0].matches[0]).toHaveProperty("lineNumber")
		expect(out[0].matches[0]).toHaveProperty("line")
	})

	it("supports ignoreCase and caps results", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "README.md", ["Alpha", "alpha", "ALPHA", "beta"].join("\n"), "add readme")

		const out = await searchRepoFiles({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ path: "README.md", query: "alpha", ignoreCase: true, maxResults: 2 }],
			maxTotalBytes: 64 * 1024,
			maxResultBytes: 16 * 1024,
			maxMatchesPerRequest: 50
		})

		expect(out).toHaveLength(1)
		expect(out[0].matches).toHaveLength(2)
		expect(out[0].isTruncated).toBe(true)
	})

	it("rejects path traversal", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "ok.txt", "hello", "add ok")

		await expect(
			searchRepoFiles({
				cwd: fx.dir,
				ref: "HEAD",
				requests: [{ path: "../secrets.txt", query: "x" }],
				maxTotalBytes: 64 * 1024,
				maxResultBytes: 16 * 1024,
				maxMatchesPerRequest: 50
			})
		).rejects.toThrow(/path/i)
	})
})
