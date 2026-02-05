import type { InstructionFile, ResolvedInstructions } from "./types"

export async function resolveInstructions(params: { targetPath: string; cwd?: string }): Promise<ResolvedInstructions> {
	// Instruction-file support has been removed.
	// This function remains for backward compatibility but always returns empty instructions.
	return {
		targetPath: params.targetPath.replace(/\\/g, "/"),
		agents: [],
		copilot: [],
		warnings: []
	}
}

export async function getResolvedInstructions(params: {
	paths: string[]
	cwd?: string
}): Promise<ResolvedInstructions[]> {
	// Instruction-file support has been removed.
	// Preserve API shape for older callers.
	return params.paths.map((p) => ({ targetPath: p.replace(/\\/g, "/"), agents: [], copilot: [], warnings: [] }))
}
