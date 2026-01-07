import { describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo } from "./gitFixture"
import { getCommitContext } from "../src/git/getCommitContext"

async function git(cwd: string, args: string[]): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		let out = ""
		let err = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (c: string) => (out += c))
		child.stderr.on("data", (c: string) => (err += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => {
			if ((code ?? 0) !== 0) return reject(new Error(`git ${args.join(" ")} failed\n${err}`))
			resolve(out)
		})
	})
}

async function commitWithBody(cwd: string, file: string, content: string, subject: string, body: string) {
	await writeFile(join(cwd, file), content, "utf8")
	await git(cwd, ["add", file])
	await git(cwd, ["commit", "-m", subject, "-m", body])
}

describe("getCommitContext", () => {
	test("returns commits in deterministic oldest->newest order", async () => {
		const { dir } = await makeTempGitRepo()
		const baseSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")

		await commitWithBody(dir, "a.txt", "hello 2\n", "feat: add thing", "Body line 1\nBody line 2")
		await commitWithBody(dir, "b.txt", "world\n", "fix: correct stuff", "")
		const headSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")

		const ctx = await getCommitContext({ cwd: dir, baseSha, headSha, mode: "snippet", maxCommits: 50 })
		expect(ctx.baseSha).toBe(baseSha)
		expect(ctx.headSha).toBe(headSha)
		expect(ctx.commits.length).toBe(2)
		expect(ctx.commits[0]!.subject).toBe("feat: add thing")
		expect(ctx.commits[1]!.subject).toBe("fix: correct stuff")
		expect(ctx.commits[0]!.bodySnippet).toMatch(/Body line 1/)
	})

	test("mode none returns empty commits", async () => {
		const { dir } = await makeTempGitRepo()
		const baseSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")
		await commitWithBody(dir, "a.txt", "hello 2\n", "feat: add thing", "Body")
		const headSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")

		const ctx = await getCommitContext({ cwd: dir, baseSha, headSha, mode: "none" })
		expect(ctx.commits).toEqual([])
	})

	test("enforces maxTotalBytes deterministically", async () => {
		const { dir } = await makeTempGitRepo()
		const baseSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")

		for (let i = 0; i < 6; i++) {
			await commitWithBody(dir, `f${i}.txt`, `c${i}\n`, `feat: ${"x".repeat(80)} ${i}`, "body")
		}
		const headSha = (await git(dir, ["rev-parse", "HEAD"]))
			.trim()
			.replace(/\s+/g, "")

		const ctx = await getCommitContext({
			cwd: dir,
			baseSha,
			headSha,
			mode: "snippet",
			maxCommits: 200,
			maxTotalBytes: 600
		})
		// Small budget should cut off deterministically, but still return at least one.
		expect(ctx.commits.length).toBeGreaterThan(0)
		expect(ctx.commits.length).toBeLessThan(6)
	})
})
