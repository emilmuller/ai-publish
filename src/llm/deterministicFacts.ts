import type { DiffSummary } from "../diff/types"
import type { EvidenceNode } from "../changelog/types"
import { compareStrings } from "../util/compare"

function inc(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by)
}

function formatCounts(label: string, counts: Map<string, number>): string {
	const keys = [...counts.keys()].sort(compareStrings)
	const parts = keys.map((k) => `${k}=${counts.get(k) ?? 0}`)
	return `${label}: ${parts.join(", ") || "(none)"}`
}

export function buildDeterministicMechanicalFacts(params: {
	diffSummary: DiffSummary
	evidence: Record<string, EvidenceNode>
}): string[] {
	const filesTotal = params.diffSummary.files.length
	const changeTypeCounts = new Map<string, number>()
	for (const f of params.diffSummary.files) inc(changeTypeCounts, f.changeType)

	const surfaceCounts = new Map<string, number>()
	const binaryFiles: string[] = []

	const nodes = Object.values(params.evidence).sort((a, b) => {
		return compareStrings(a.filePath, b.filePath) || compareStrings(a.id, b.id)
	})

	for (const n of nodes) {
		inc(surfaceCounts, n.surface)
		if (n.isBinary) binaryFiles.push(n.filePath)
	}

	const facts: string[] = []
	facts.push(`filesChanged: ${filesTotal}`)
	facts.push(formatCounts("changeTypes", changeTypeCounts))
	facts.push(formatCounts("surfaces", surfaceCounts))
	facts.push(`binaryFiles: ${binaryFiles.length}`)
	if (binaryFiles.length) facts.push(`binaryPaths: ${binaryFiles.sort(compareStrings).join(", ")}`)

	// Add a compact, deterministic per-file index to help the LLM target hunks.
	// (This is metadata-only; no patch text.)
	for (const n of nodes) {
		facts.push(
			[
				`file: ${n.filePath}`,
				n.oldPath ? `oldFile: ${n.oldPath}` : "",
				`type: ${n.changeType}`,
				`surface: ${n.surface}`,
				`binary: ${n.isBinary ? "yes" : "no"}`,
				`hunks: ${n.hunkIds.length}`
			]
				.filter(Boolean)
				.join(" | ")
		)
	}

	return facts
}
