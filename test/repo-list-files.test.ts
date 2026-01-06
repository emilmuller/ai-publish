import { describe, expect, it } from "vitest"

import { listRepoFiles } from "../src/repo/listRepoFiles"
import { commitChange, makeTempGitRepo } from "./gitFixture"

describe("listRepoFiles", () => {
	it("lists paths with prefix + extension filters", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "src/a.ts", "export const a = 1\n", "add a")
		await commitChange(fx.dir, "src/b.md", "# b\n", "add b")
		await commitChange(fx.dir, "docs/c.ts", "export const c = 1\n", "add c")

		const out = await listRepoFiles({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ pathPrefix: "src/", fileExtensions: [".ts"] }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 200
		})

		expect(out).toHaveLength(1)
		expect(out[0].ref).toBe("HEAD")
		expect(out[0].paths.every((p) => p.startsWith("src/"))).toBe(true)
		expect(out[0].paths.every((p) => p.endsWith(".ts"))).toBe(true)
	})

	it("caps results and marks truncated", async () => {
		const fx = await makeTempGitRepo()
		for (let i = 0; i < 8; i++) {
			await commitChange(fx.dir, `src/f${i}.ts`, `export const x${i} = ${i}\n`, `add f${i}`)
		}

		const out = await listRepoFiles({
			cwd: fx.dir,
			ref: "HEAD",
			requests: [{ pathPrefix: "src/", maxFiles: 3 }],
			maxTotalBytes: 64 * 1024,
			maxFilesPerRequest: 200
		})

		expect(out[0].paths.length).toBe(3)
		expect(out[0].isTruncated).toBe(true)
	}, 60_000)

	it("rejects path traversal", async () => {
		const fx = await makeTempGitRepo()
		await commitChange(fx.dir, "ok.txt", "hello\n", "add ok")

		await expect(
			listRepoFiles({
				cwd: fx.dir,
				ref: "HEAD",
				requests: [{ pathPrefix: "../" }],
				maxTotalBytes: 64 * 1024,
				maxFilesPerRequest: 200
			})
		).rejects.toThrow(/pathPrefix|path/i)
	})
})
