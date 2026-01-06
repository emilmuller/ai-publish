import { readFile, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { runGitOrThrow } from "../git/runGit"
import { parseDirectivesFromText } from "./directives"
import type { InstructionFile, ResolvedInstructions } from "./types"

const COPILOT_FILENAMES = ["copilot-instructions.md", join(".github", "copilot-instructions.md")]

async function existsFile(path: string): Promise<boolean> {
	try {
		const s = await stat(path)
		return s.isFile()
	} catch {
		return false
	}
}

function detectDirectiveConflicts(files: InstructionFile[]): string[] {
	const warnings: string[] = []
	const seen = new Map<string, { value: string; from: string }>()

	for (const f of files) {
		const directives = parseDirectivesFromText(f.content)
		for (const [k, v] of Object.entries(directives)) {
			const prev = seen.get(k)
			if (!prev) {
				seen.set(k, { value: v, from: f.path })
				continue
			}
			if (prev.value !== v) {
				warnings.push(
					`Instruction conflict for '${k}': '${prev.value}' (${prev.from}) vs '${v}' (${f.path}). Nearest wins.`
				)
			}
		}
	}

	return warnings
}

async function getRepoRoot(cwd: string): Promise<string> {
	try {
		return (await runGitOrThrow(["rev-parse", "--show-toplevel"], { cwd })).trim()
	} catch {
		return cwd
	}
}

function getAncestorDirs(repoRoot: string, targetAbsPath: string): string[] {
	const root = resolve(repoRoot)
	const target = resolve(targetAbsPath)

	if (!target.startsWith(root)) return [root]

	const rel = target.slice(root.length).replace(/^[/\\]/, "")
	const parts = rel.split(/[/\\]+/).filter(Boolean)

	const dirs: string[] = [root]
	let cur = root
	for (let i = 0; i < parts.length - 1; i++) {
		cur = join(cur, parts[i]!)
		dirs.push(cur)
	}
	return dirs
}

async function loadInstructionFiles(kind: InstructionFile["kind"], dirs: string[]): Promise<InstructionFile[]> {
	const results: InstructionFile[] = []

	for (const d of dirs) {
		const candidates = kind === "agents" ? ["AGENTS.md"] : COPILOT_FILENAMES
		for (const c of candidates) {
			const p = join(d, c)
			if (!(await existsFile(p))) continue
			const content = await readFile(p, "utf8")
			results.push({ path: p, kind, content })
		}
	}

	return results
}

export async function resolveInstructions(params: { targetPath: string; cwd?: string }): Promise<ResolvedInstructions> {
	const cwd = params.cwd ?? process.cwd()
	const repoRoot = await getRepoRoot(cwd)

	const targetAbs = resolve(repoRoot, params.targetPath)
	const dirs = getAncestorDirs(repoRoot, targetAbs)

	const agents = await loadInstructionFiles("agents", dirs)
	const copilot = await loadInstructionFiles("copilot", dirs)

	const warnings = [...detectDirectiveConflicts(agents), ...detectDirectiveConflicts(copilot)]

	return {
		targetPath: params.targetPath.replace(/\\/g, "/"),
		agents,
		copilot,
		warnings
	}
}

export async function getResolvedInstructions(params: {
	paths: string[]
	cwd?: string
}): Promise<ResolvedInstructions[]> {
	const results: ResolvedInstructions[] = []
	for (const p of params.paths) {
		results.push(await resolveInstructions({ targetPath: p, cwd: params.cwd }))
	}
	return results
}
