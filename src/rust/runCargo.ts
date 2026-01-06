import { spawn } from "node:child_process"

export type RunCargoOptions = {
	cwd?: string
	maxStderrBytes?: number
}

export async function runCargoCapture(
	args: string[],
	options: RunCargoOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cwd, maxStderrBytes = 128 * 1024 } = options

	return await new Promise((resolve, reject) => {
		const child = spawn("cargo", args, {
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

export async function runCargoOrThrow(args: string[], options: RunCargoOptions = {}): Promise<string> {
	const { stdout, stderr, exitCode } = await runCargoCapture(args, options)
	if (exitCode !== 0) {
		const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
		throw new Error(`cargo ${args.join(" ")} failed (exit ${exitCode})${suffix}`)
	}
	return stdout
}
