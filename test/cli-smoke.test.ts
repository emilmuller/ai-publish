import { describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"

function run(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (c: string) => (stdout += c))
		child.stderr.on("data", (c: string) => (stderr += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? 0 }))
	})
}

describe("CLI smoke", () => {
	test("built dist/cli.js prints help", async () => {
		const cwd = join(__dirname, "..")
		const tscPath = join(cwd, "node_modules", "typescript", "bin", "tsc")
		const build = await run(process.execPath, [tscPath, "-p", "tsconfig.build.json"], cwd)
		expect(build.code).toBe(0)

		const cliPath = join(cwd, "dist", "cli.js")
		await access(cliPath)

		const res = await run("node", [cliPath, "--help"], cwd)
		expect(res.code).toBe(0)
		const combined = `${res.stdout}\n${res.stderr}`
		expect(combined).toMatch(/Usage:/)
		expect(combined).toMatch(/ai-publish changelog \[--base/)
		expect(combined).toMatch(/ai-publish release-notes \[--base/)
		expect(combined).toMatch(/ai-publish prepublish/)
		expect(combined).toMatch(/ai-publish postpublish/)
	})
})
