import { spawn } from "node:child_process"

export type RunNpmOptions = {
	cwd?: string
	maxStderrBytes?: number
}

export async function runNpmCapture(
	args: string[],
	options: RunNpmOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cwd, maxStderrBytes = 128 * 1024 } = options
	// Windows note:
	// On some newer Node.js versions (observed on Node v25.x), spawning `npm.cmd`
	// directly can fail with `spawn EINVAL`. Running npm through `cmd.exe /c` is
	// more robust.
	const isWin = process.platform === "win32"
	const command = isWin ? "cmd.exe" : "npm"
	const commandArgs = isWin ? ["/d", "/s", "/c", "npm", ...args] : args

	return await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true
		})

		let stdout = ""
		let stderr = ""

		child.stdout!.setEncoding("utf8")
		child.stderr!.setEncoding("utf8")

		child.stdout!.on("data", (chunk: string) => {
			stdout += chunk
		})

		child.stderr!.on("data", (chunk: string) => {
			if (stderr.length < maxStderrBytes) {
				const remaining = maxStderrBytes - stderr.length
				stderr += chunk.slice(0, remaining)
			}
		})

		child.on("error", reject)

		child.on("close", (code: number | null) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 })
		})
	})
}

export async function runNpmOrThrow(args: string[], options: RunNpmOptions = {}): Promise<string> {
	const { stdout, stderr, exitCode } = await runNpmCapture(args, options)
	if (exitCode !== 0) {
		const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
		throw new Error(`npm ${args.join(" ")} failed (exit ${exitCode})${suffix}`)
	}
	return stdout
}
