import type { InstructionFile, ResolvedInstructions } from "./types"

export type InstructionDirectives = Record<string, string>

export function parseDirectivesFromText(text: string): InstructionDirectives {
	// Best-effort parser for directives written as single-line "key: value".
	// Keys are case-sensitive and values are raw strings (callers interpret).
	const directives: InstructionDirectives = {}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line) continue
		if (line.startsWith("#")) continue
		const m = /^([A-Za-z0-9_.-]{2,}):\s*(.+)$/.exec(line)
		if (!m) continue
		directives[m[1]!] = m[2]!
	}
	return directives
}

function mergeDirectives(files: InstructionFile[]): InstructionDirectives {
	// Instruction resolution lists files from repo root -> target directory.
	// Nearest wins, so later files override earlier ones.
	const merged: InstructionDirectives = {}
	for (const f of files) {
		Object.assign(merged, parseDirectivesFromText(f.content))
	}
	return merged
}

export function getMergedDirectives(resolved: ResolvedInstructions): InstructionDirectives {
	return {
		...mergeDirectives(resolved.agents),
		...mergeDirectives(resolved.copilot)
	}
}

export function splitList(value: string | undefined): string[] {
	if (!value) return []
	return value
		.split(/[,\n]/g)
		.map((s) => s.trim())
		.filter(Boolean)
}

export function normalizeRepoPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}
