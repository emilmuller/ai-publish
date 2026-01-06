import { describe, expect, it } from "vitest"

import { searchRepoPaths } from "../src/repo/searchRepoPaths"
import { commitChange, makeTempGitRepo } from "./gitFixture"

describe("searchRepoPaths", () => {
	it("returns matching paths with prefix + extension filters", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "src/example.ts", "export const x = 1\n", "add example")
		await commitChange(fx.dir, "src/example.md", "# example\n", "add example md")
		await commitChange(fx.dir, "docs/example.ts", "export const y = 2\n", "add docs")

		const out = await searchRepoPaths({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ query: "example", pathPrefix: "src/", fileExtensions: [".ts"] }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 200
		})

		expect(out).toHaveLength(1)
		expect(out[0].ref).toBe("HEAD")
		expect(out[0].query).toBe("example")
		expect(out[0].paths).toEqual(["src/example.ts"])
	})

	it("caps results and marks truncated", async () => {
		const fx = await makeTempGitRepo()
		for (let i = 0; i < 8; i++) {
			await commitChange(fx.dir, `src/example-${i}.ts`, `export const x${i} = ${i}\n`, `add ${i}`)
		}

		const out = await searchRepoPaths({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ query: "example", pathPrefix: "src/", maxFiles: 3 }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 200
		})

		expect(out[0].paths.length).toBeLessThanOrEqual(3)
		expect(out[0].isTruncated).toBe(true)
	}, 60_000)

	it("rejects path traversal", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "ok.txt", "hello\n", "add ok")

		await expect(
			searchRepoPaths({
				cwd: fx.dir,
				ref: "HEAD",
				requests: [{ query: "ok", pathPrefix: "../" }],
				maxTotalBytes: 64 * 1024,
				maxFilesPerRequest: 200
			})
		).rejects.toThrow(/pathPrefix|path/i)
	})
})
