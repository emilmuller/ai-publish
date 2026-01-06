import type { LLMClient, SemanticTools } from "../src/llm/types"
import type { EvidenceNode, ChangelogBullet, ChangelogModel } from "../src/changelog/types"
import type { DiffHunk } from "../src/diff/types"
import { compareStrings } from "../src/util/compare"

type SemanticNote = {
	evidenceNodeId: string
	summary: string
}

function toJsonNote(n: SemanticNote): string {
	return JSON.stringify(n)
}

function tryParseJsonNote(s: string): SemanticNote | null {
	try {
		const obj = JSON.parse(s) as any
		if (!obj || typeof obj !== "object") return null
		if (typeof obj.evidenceNodeId !== "string") return null
		if (typeof obj.summary !== "string") return null
		return { evidenceNodeId: obj.evidenceNodeId, summary: obj.summary }
	} catch {
		return null
	}
}

function firstMeaningfulAddedLine(hunk: DiffHunk): string | null {
	for (const line of hunk.lines) {
		if (!line.startsWith("+")) continue
		if (line.startsWith("+++")) continue
		const t = line.slice(1).trim()
		if (!t) continue
		return t
	}
	return null
}

function firstMeaningfulRemovedLine(hunk: DiffHunk): string | null {
	for (const line of hunk.lines) {
		if (!line.startsWith("-")) continue
		if (line.startsWith("---")) continue
		const t = line.slice(1).trim()
		if (!t) continue
		return t
	}
	return null
}

function summarizeHunksForNode(node: EvidenceNode, hunks: DiffHunk[]): string {
	// Prefer a simple human-oriented summary derived from bounded hunk content.
	if (node.changeType === "delete") return "Removed obsolete content"

	const relevant = hunks.filter((h) => node.hunkIds.includes(h.id))
	const textual = relevant.filter((h) => h.header !== "@@ meta @@")

	// Added public API file: try to extract an exported symbol.
	if (node.changeType === "add" && node.filePath.endsWith(".ts")) {
		const line = textual.map(firstMeaningfulAddedLine).find(Boolean) ?? null
		if (line) {
			const m = /^export\s+(?:const|function|class|type|interface)\s+([A-Za-z0-9_]+)/.exec(line)
			if (m?.[1]) {
				return `Expose ${m[1]} in public API`
			}
			return `Add public API surface in ${node.filePath}`
		}
		return `Add public API surface in ${node.filePath}`
	}

	// Config tweak: detect simple "key: value" change.
	if (node.filePath.endsWith(".yml") || node.filePath.endsWith(".yaml")) {
		const removed = textual.map(firstMeaningfulRemovedLine).find(Boolean) ?? null
		const added = textual.map(firstMeaningfulAddedLine).find(Boolean) ?? null
		if (removed && added) {
			const rm = /^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/.exec(removed)
			const am = /^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/.exec(added)
			if (rm && am && rm[1] === am[1]) {
				return `Update ${rm[1]} from '${rm[2]}' to '${am[2]}'`
			}
			return `Update configuration in ${node.filePath}`
		}
		return `Update configuration in ${node.filePath}`
	}

	if (node.changeType === "add") return `Add ${node.filePath}`
	return "Internal improvements"
}

export function makeDeterministicTestLLMClient(): LLMClient {
	return {
		async pass1Mechanical(input) {
			return {
				notes: input.diffSummary.files
					.map((f) => `${f.changeType} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""}`)
					.sort(compareStrings)
			}
		},
		async pass2Semantic(input, tools: SemanticTools) {
			const allHunkIds = Object.values(input.evidence)
				.flatMap((e) => e.hunkIds)
				.filter(Boolean)
				.sort(compareStrings)

			const hunks = allHunkIds.length ? await tools.getDiffHunks(allHunkIds) : ([] as DiffHunk[])

			const notes: string[] = []
			for (const node of Object.values(input.evidence).sort((a, b) => {
				return compareStrings(a.filePath, b.filePath) || compareStrings(a.id, b.id)
			})) {
				const summary = summarizeHunksForNode(node, hunks)
				notes.push(toJsonNote({ evidenceNodeId: node.id, summary }))
			}

			return { notes }
		},
		async pass3Editorial(input) {
			function bullet(text: string, node: EvidenceNode): ChangelogBullet {
				return { text, evidenceNodeIds: [node.id] }
			}

			const byNodeId = new Map<string, string>()
			for (const raw of input.semantic.notes) {
				const parsed = tryParseJsonNote(raw)
				if (!parsed) continue
				byNodeId.set(parsed.evidenceNodeId, parsed.summary)
			}

			const model: ChangelogModel = {
				breakingChanges: [],
				added: [],
				changed: [],
				fixed: [],
				removed: [],
				internalTooling: [],
				evidence: {}
			}

			const nodes = Object.values(input.evidence).sort((a, b) => {
				return compareStrings(a.filePath, b.filePath) || compareStrings(a.id, b.id)
			})

			for (const node of nodes) {
				const summary = byNodeId.get(node.id) ?? `${node.changeType} ${node.filePath}`

				const isInternalOnly =
					node.surface === "internal" || node.surface === "tests" || node.surface === "infra"
				if (isInternalOnly) {
					model.internalTooling.push(bullet(summary, node))
					continue
				}
				if (node.changeType === "delete") {
					model.removed.push(bullet(summary, node))
					continue
				}
				if (node.changeType === "add") {
					model.added.push(bullet(summary, node))
					continue
				}
				model.changed.push(bullet(summary, node))
			}

			return model
		},
		async pass3ReleaseNotes(input) {
			const byNodeId = new Map<string, string>()
			for (const raw of input.semantic.notes) {
				const parsed = tryParseJsonNote(raw)
				if (!parsed) continue
				byNodeId.set(parsed.evidenceNodeId, parsed.summary)
			}

			const changeOrder: Record<string, number> = { add: 0, modify: 1, rename: 2, delete: 3 }
			const nodes = Object.values(input.evidence).sort((a, b) => {
				const ao = changeOrder[a.changeType] ?? 99
				const bo = changeOrder[b.changeType] ?? 99
				return ao - bo || compareStrings(a.filePath, b.filePath) || compareStrings(a.id, b.id)
			})

			const bulletLines: string[] = []
			for (const node of nodes) {
				const summary = byNodeId.get(node.id) ?? `${node.changeType} ${node.filePath}`
				bulletLines.push(`- ${summary}`)
			}

			return {
				markdown: bulletLines.join("\n"),
				evidenceNodeIds: nodes.map((n) => n.id)
			}
		},
		async pass3VersionBump(input) {
			return {
				nextVersion: input.nextVersion,
				justification: `Computed a ${input.bumpType} bump from ${input.previousVersion} to ${input.nextVersion} based on the changelog model.`
			}
		}
	}
}
