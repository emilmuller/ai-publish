import { runGitOrThrow } from "../git/runGit"
import type { DiffChangeType, DiffFileSummary, DiffSummary } from "./types"
import { compareStrings } from "../util/compare"

function parseNameStatusLine(line: string): DiffFileSummary | null {
	// Formats:
	//  M\tpath
	//  A\tpath
	//  D\tpath
	//  R100\told\tnew
	//  C100\told\tnew
	const parts = line.split("\t")
	if (parts.length < 2) return null

	const status = parts[0]
	const code = status[0]

	if (code === "R" || code === "C") {
		if (parts.length < 3) return null
		const oldPath = parts[1]
		const path = parts[2]
		return {
			path,
			oldPath,
			changeType: code === "R" ? "rename" : "copy",
			isBinary: false
		}
	}

	const path = parts[1]
	const changeType: DiffChangeType = code === "A" ? "add" : code === "D" ? "delete" : "modify"

	return { path, changeType, isBinary: false }
}

function parseNumstat(stdout: string): Map<string, { isBinary: boolean }> {
	// Each line: <adds>\t<dels>\t<path>
	// For binary: -\t-\t<path>
	const map = new Map<string, { isBinary: boolean }>()
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trimEnd()
		if (!line) continue
		const parts = line.split("\t")
		if (parts.length < 3) continue
		const [adds, dels, path] = parts
		map.set(path, { isBinary: adds === "-" && dels === "-" })
	}
	return map
}

export async function getDiffSummary(base: string, options: { cwd?: string } = {}): Promise<DiffSummary> {
	const { cwd } = options
	const baseSha = (await runGitOrThrow(["rev-parse", base], { cwd })).trim()
	const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd })).trim()

	const nameStatus = await runGitOrThrow(
		["diff", "--name-status", "-M", "-C", "--find-renames", `${baseSha}..${headSha}`],
		{ cwd }
	)
	const numstat = await runGitOrThrow(["diff", "--numstat", "-M", "--find-renames", `${baseSha}..${headSha}`], {
		cwd
	})

	const binaryByPath = parseNumstat(numstat)

	const files: DiffFileSummary[] = []

	for (const rawLine of nameStatus.split(/\r?\n/)) {
		const line = rawLine.trimEnd()
		if (!line) continue
		const parsed = parseNameStatusLine(line)
		if (!parsed) continue

		const binary = binaryByPath.get(parsed.path)?.isBinary ?? false
		files.push({ ...parsed, isBinary: binary })
	}

	// Deterministic ordering
	files.sort((a, b) => compareStrings(a.path, b.path))

	return {
		baseSha,
		headSha,
		files,
		totalHunks: 0
	}
}
