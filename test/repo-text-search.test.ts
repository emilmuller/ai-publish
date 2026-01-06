import { describe, expect, it } from "vitest"

import { searchRepoText } from "../src/repo/searchRepoText"
import { commitChange, makeTempGitRepo } from "./gitFixture"

describe("searchRepoText", () => {
	it("finds matches across multiple files", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "src/a.ts", "export const foo = 1\n", "add a")
		await commitChange(fx.dir, "src/b.ts", "export function bar() { return foo }\n", "add b")
		await commitChange(fx.dir, "README.md", "foo appears here too\n", "add readme")

		const out = await searchRepoText({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ query: "foo", pathPrefix: "src/", fileExtensions: [".ts"] }],
			maxTotalBytes: 64 * 1024,
			maxResultBytes: 16 * 1024,
			maxMatchesPerRequest: 50,
			maxFilesPerRequest: 200
		})

		expect(out).toHaveLength(1)
		expect(out[0].matches.length).toBeGreaterThan(0)
		expect(out[0].matches.every((m) => m.path.startsWith("src/"))).toBe(true)
		expect(out[0].matches.every((m) => m.path.endsWith(".ts"))).toBe(true)
	})

	it("caps results and marks truncated", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(
			fx.dir,
			"src/huge.ts",
			Array.from({ length: 200 }, () => "foo").join("\n") + "\n",
			"add huge"
		)

		const out = await searchRepoText({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ query: "foo", maxResults: 5 }],
			maxTotalBytes: 64 * 1024,
			maxResultBytes: 16 * 1024,
			maxMatchesPerRequest: 50,
			maxFilesPerRequest: 200
		})

		expect(out[0].matches).toHaveLength(5)
		expect(out[0].isTruncated).toBe(true)
	})
})
