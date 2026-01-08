import type { DiffHunk } from "../diff/types"
import { getDiffHunks } from "../diff/getDiffHunks"

function isMaxTotalBytesExceededError(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("message" in err)) return false
	const msg = (err as { message?: unknown }).message
	return typeof msg === "string" && msg.includes("Requested hunks exceed maxTotalBytes")
}

export async function fetchHunksWithBudget(opts: {
	base: string
	cwd: string
	indexRootDir?: string
	/** Allowed hunk id set for validation */
	allowedHunkIds: Set<string>
	/** Mutable state object containing remainingBytes that will be decremented */
	state: { remainingBytes: number }
	hunkIds: string[]
	/** max chunk size per request (default 12) */
	maxChunk?: number
}): Promise<DiffHunk[]> {
	const { base, cwd, indexRootDir, allowedHunkIds, state, hunkIds, maxChunk = 12 } = opts

	// Ignore unknown IDs (tool-gating): return only evidence-known hunks.
	// Important: do not drop known IDs just because unknown ones were requested.
	const allowed = hunkIds.filter((id) => allowedHunkIds.has(id))
	if (!allowed.length) return []

	if (state.remainingBytes <= 0) throw new Error("LLM hunk budget exhausted")

	const collected: DiffHunk[] = []
	let cursor = 0

	while (cursor < allowed.length) {
		if (state.remainingBytes <= 0) break
		let chunkSize = Math.min(maxChunk, allowed.length - cursor)

		while (chunkSize > 0) {
			const chunkIds = allowed.slice(cursor, cursor + chunkSize)
			try {
				const hunks = await getDiffHunks({
					base,
					hunkIds: chunkIds,
					cwd,
					indexRootDir,
					maxTotalBytes: state.remainingBytes
				})
				collected.push(...hunks)
				const used = hunks.reduce((sum: number, h: DiffHunk) => sum + (h.byteLength ?? 0), 0)
				state.remainingBytes -= used
				cursor += chunkSize
				break
			} catch (err) {
				if (isMaxTotalBytesExceededError(err)) {
					if (chunkSize === 1) {
						// Skip an over-sized single hunk rather than fail the run.
						cursor += 1
						break
					}
					chunkSize = Math.max(1, Math.floor(chunkSize / 2))
					continue
				}
				throw err
			}
		}
	}

	return collected
}
