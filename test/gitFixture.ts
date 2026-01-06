import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		let out = ""
		let err = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (c: string) => (out += c))
		child.stderr.on("data", (c: string) => (err += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => {
			if ((code ?? 0) !== 0) return reject(new Error(`${cmd} ${args.join(" ")} failed\n${err}`))
			resolve(out)
		})
	})
}

async function runCapture(
	cmd: string,
	args: string[],
	cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (c: string) => (stdout += c))
		child.stderr.on("data", (c: string) => (stderr += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 0 }))
	})
}

export async function makeTempGitRepo(): Promise<{ dir: string }> {
	const dir = join(tmpdir(), `ai-publish-fixture-${randomUUID()}`)
	await mkdir(dir, { recursive: true })

	await run("git", ["init"], dir)
	await run("git", ["config", "user.email", "test@example.com"], dir)
	await run("git", ["config", "user.name", "Test"], dir)

	// Ensure ai-publish's diff index cache does not dirty the worktree in tests.
	await writeFile(join(dir, ".gitignore"), ".ai-publish/\n", "utf8")

	await writeFile(join(dir, "a.txt"), "hello\n", "utf8")
	await run("git", ["add", "."], dir)
	await run("git", ["commit", "-m", "base"], dir)

	return { dir }
}

export async function makeBareRemoteAndAddOrigin(localDir: string): Promise<{ remoteDir: string }> {
	const remoteDir = join(tmpdir(), `ai-publish-remote-${randomUUID()}`)
	await mkdir(remoteDir, { recursive: true })
	await run("git", ["init", "--bare"], remoteDir)
	await run("git", ["remote", "add", "origin", remoteDir], localDir)
	return { remoteDir }
}

export async function gitShowRef(
	cwd: string,
	ref: string
): Promise<{ found: boolean; sha: string | null; stderr: string | null }> {
	const res = await runCapture("git", ["show-ref", "--verify", ref], cwd)
	if (res.exitCode !== 0) {
		return { found: false, sha: null, stderr: res.stderr.trim() || null }
	}
	const line = (res.stdout.trim().split(/\r?\n/)[0] ?? "").trim()
	const sha = line.split(/\s+/)[0] ?? ""
	return { found: true, sha: sha || null, stderr: res.stderr.trim() || null }
}

export async function commitChange(dir: string, path: string, content: string, message: string): Promise<string> {
	await mkdir(join(dir, path, ".."), { recursive: true }).catch(() => undefined)
	await writeFile(join(dir, path), content, "utf8")
	await run("git", ["add", path], dir)
	await run("git", ["commit", "-m", message], dir)
	return (await run("git", ["rev-parse", "HEAD"], dir)).trim()
}
