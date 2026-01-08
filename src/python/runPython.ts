import { spawn } from "node:child_process"

export type RunPythonOptions = {
	cwd?: string
	maxStderrBytes?: number
	pythonCommand?: string
}

function asENOENT(err: unknown): { code?: unknown; message?: string } {
	if (!err || typeof err !== "object") return {}
	const e = err as { code?: unknown; message?: unknown }
	return { code: e.code, message: typeof e.message === "string" ? e.message : undefined }
}

async function runPythonCaptureWithCommand(
	pythonCommand: string,
	args: string[],
	options: Omit<RunPythonOptions, "pythonCommand"> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { cwd, maxStderrBytes = 128 * 1024 } = options

	return await new Promise((resolve, reject) => {
		const child = spawn(pythonCommand, args, {
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

export async function runPythonCapture(
	args: string[],
	options: RunPythonOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const cmd = options.pythonCommand ?? process.env.AI_PUBLISH_PYTHON ?? process.env.PYTHON ?? "python"
	try {
		return await runPythonCaptureWithCommand(cmd, args, options)
	} catch (err) {
		// Windows often uses the Python launcher (`py`) instead of `python`.
		const e = asENOENT(err)
		if (cmd === "python" && e.code === "ENOENT") {
			return await runPythonCaptureWithCommand("py", args, options)
		}
		throw err
	}
}

export async function runPythonOrThrow(args: string[], options: RunPythonOptions = {}): Promise<string> {
	const cmd = options.pythonCommand ?? process.env.AI_PUBLISH_PYTHON ?? process.env.PYTHON ?? "python"
	let res: { stdout: string; stderr: string; exitCode: number }
	try {
		res = await runPythonCaptureWithCommand(cmd, args, options)
	} catch (err) {
		const e = asENOENT(err)
		if (cmd === "python" && e.code === "ENOENT") {
			res = await runPythonCaptureWithCommand("py", args, options)
		} else {
			throw err
		}
	}

	if (res.exitCode !== 0) {
		const suffix = res.stderr.trim() ? `\n${res.stderr.trim()}` : ""
		throw new Error(`python ${args.join(" ")} failed (exit ${res.exitCode})${suffix}`)
	}
	return res.stdout
}
