import { spawn } from "node:child_process"

export type RunGitOptions = {
	cwd?: string
	/** Optional stdin content to pass to git. */
	stdin?: string
	/** Upper bound on captured stderr bytes (stdout may be streamed elsewhere). */
	maxStderrBytes?: number
}

export async function runGitCapture(
	args: string[],
	options: RunGitOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cwd, stdin, maxStderrBytes = 128 * 1024 } = options

	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

		if (stdin !== undefined) {
			child.stdin!.setDefaultEncoding("utf8")
			child.stdin!.write(stdin)
			child.stdin!.end()
		}

		child.on("close", (code: number | null) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 })
		})
	})
}

export async function runGitOrThrow(args: string[], options: RunGitOptions = {}): Promise<string> {
	const { stdout, stderr, exitCode } = await runGitCapture(args, options)
	if (exitCode !== 0) {
		const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode})${suffix}`)
	}
	return stdout
}
