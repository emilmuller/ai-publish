import { spawn } from "node:child_process"

export type RunDotnetOptions = {
	cwd?: string
	maxStderrBytes?: number
}

export async function runDotnetCapture(
	args: string[],
	options: RunDotnetOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cwd, maxStderrBytes = 128 * 1024 } = options

	return await new Promise((resolve, reject) => {
		const child = spawn("dotnet", args, {
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

export async function runDotnetOrThrow(args: string[], options: RunDotnetOptions = {}): Promise<string> {
	const { stdout, stderr, exitCode } = await runDotnetCapture(args, options)
	if (exitCode !== 0) {
		const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
		throw new Error(`dotnet ${args.join(" ")} failed (exit ${exitCode})${suffix}`)
	}
	return stdout
}
