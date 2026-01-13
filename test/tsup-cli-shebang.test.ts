import { describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

function npmExecPathOrThrow(): string {
	const p = process.env.npm_execpath
	if (!p) {
		throw new Error("npm_execpath is not set; tests must be run via npm")
	}
	return p
}

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

describe("tsup CLI artifact", () => {
	test("dist/cli.js starts with a node shebang", async () => {
		const cwd = join(__dirname, "..")
		const build = await run(process.execPath, [npmExecPathOrThrow(), "run", "build"], cwd)
		expect(build.code).toBe(0)

		const cliPath = join(cwd, "dist", "cli.js")
		const content = await readFile(cliPath, "utf8")
		const firstLine = content.split(/\r?\n/)[0]
		expect(firstLine).toBe("#!/usr/bin/env node")
	})
})
