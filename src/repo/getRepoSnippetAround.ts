import type { RepoSnippetAroundRequest, RepoSnippetAroundResult } from "./types"
import { getRepoFileSnippets } from "./getRepoFileSnippets"

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

export async function getRepoSnippetAround(params: {
	cwd: string
	ref: string
	requests: RepoSnippetAroundRequest[]
	maxTotalBytes: number
	maxSnippetBytes: number
	maxSnippetLines: number
	maxContextLines: number
}): Promise<RepoSnippetAroundResult[]> {
	const { cwd, ref, maxTotalBytes, maxSnippetBytes, maxSnippetLines, maxContextLines } = params

	// Map to the existing snippet tool (which already enforces path safety and bounding).
	const mapped = params.requests.map((r) => {
		const requestedLine = clampInt(r.lineNumber, 1, Number.MAX_SAFE_INTEGER)
		const contextLines = clampInt(r.contextLines ?? 40, 0, maxContextLines)
		const startLine = Math.max(1, requestedLine - contextLines)
		const endLine = startLine + Math.min(maxSnippetLines - 1, contextLines * 2)
		return { path: r.path, requestedLine, contextLines, startLine, endLine }
	})

	const snippets = await getRepoFileSnippets({
		cwd,
		ref,
		requests: mapped.map((m) => ({ path: m.path, startLine: m.startLine, endLine: m.endLine })),
		maxTotalBytes,
		maxSnippetBytes,
		maxSnippetLines
	})

	return snippets.map((s, i) => {
		const m = mapped[i]!
		return {
			path: s.path,
			ref: s.ref,
			requestedLine: m.requestedLine,
			contextLines: m.contextLines,
			startLine: s.startLine,
			endLine: s.endLine,
			lines: s.lines,
			isTruncated: s.isTruncated,
			byteLength: s.byteLength
		}
	})
}
