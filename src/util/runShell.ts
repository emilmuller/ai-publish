import { spawn } from "node:child_process"

export async function runShellOrThrow(params: { cwd: string; command: string }): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(params.command, {
			cwd: params.cwd,
			shell: true,
			stdio: "inherit"
		})
		child.on("error", reject)
		child.on("exit", (code, signal) => {
			if (code === 0) return resolve()
			reject(new Error(`Command failed (${code ?? signal}): ${params.command}`))
		})
	})
}
