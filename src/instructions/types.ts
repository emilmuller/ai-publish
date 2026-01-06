export type InstructionFile = {
	path: string
	kind: "agents" | "copilot"
	content: string
}

export type ResolvedInstructions = {
	targetPath: string
	agents: InstructionFile[]
	copilot: InstructionFile[]
	warnings: string[]
}
