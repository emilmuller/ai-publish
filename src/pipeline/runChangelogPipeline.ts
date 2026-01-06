import { indexDiff, getDiffHunks } from "../diff"
import { getResolvedInstructions } from "../instructions/resolveInstructions"
import type { LLMClient } from "../llm/types"
import type { ChangelogModel } from "../changelog/types"
import type { DiffIndexManifest, DiffHunk } from "../diff/types"
import { buildEvidenceFromManifest } from "../changelog/evidence"
import { validateChangelogModel } from "../changelog/validate"
import { compareStrings } from "../util/compare"
import { buildDeterministicMechanicalFacts } from "../llm/deterministicFacts"
import { getRepoFileSnippets } from "../repo/getRepoFileSnippets"
import { getRepoSnippetAround } from "../repo/getRepoSnippetAround"
import { getRepoFileMeta } from "../repo/getRepoFileMeta"
import { searchRepoFiles } from "../repo/searchRepoFiles"
import { searchRepoPaths } from "../repo/searchRepoPaths"
import { searchRepoText } from "../repo/searchRepoText"
import { listRepoFiles } from "../repo/listRepoFiles"

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1"
}

function debugLog(...args: any[]) {
	if (!debugEnabled()) return
	// eslint-disable-next-line no-console
	console.error("[ai-publish][debug]", ...args)
}

// NOTE: ai-publish is LLM-driven.
// This pipeline always requires an injected LLM client (the CLI uses Azure OpenAI).
// Tests may inject a local stub client to keep CI network-free.
export async function runChangelogPipeline(params: {
	base: string
	/** Optional label for rendering output (does not affect diff authority). */
	baseLabel?: string
	/** Optional label for rendering output (does not affect diff authority). */
	headLabel?: string
	cwd?: string
	llmClient: LLMClient
}): Promise<{ markdown: string; model: ChangelogModel }> {
	const cwd = params.cwd ?? process.cwd()
	debugLog("changelogPipeline", { base: params.base, cwd })

	// Always build the diff index first; it is the queryable authority.
	debugLog("changelogPipeline:indexDiff")
	const indexRes = await indexDiff({ base: params.base, cwd })
	debugLog("changelogPipeline:indexed", {
		baseSha: indexRes.baseSha,
		headSha: indexRes.headSha,
		files: indexRes.summary.files.length
	})

	// LLM mode (scaffold): follow the 3-pass contract and tool-gating.
	// Reuse the indexed diff summary to keep totals consistent and avoid redundant git calls.
	const diffSummary = indexRes.summary
	const resolvedInstructions = await getResolvedInstructions({ cwd, paths: diffSummary.files.map((f) => f.path) })
	const instructionsByPath = Object.fromEntries(resolvedInstructions.map((r) => [r.targetPath, r]))

	const diffIndexManifest = indexRes.manifest as DiffIndexManifest
	const evidence = buildEvidenceFromManifest(diffIndexManifest, { instructionsByPath })
	const deterministicFacts = buildDeterministicMechanicalFacts({ diffSummary, evidence })

	const mechanical = await params.llmClient.pass1Mechanical({
		base: params.base,
		diffSummary,
		diffIndexManifest,
		evidence,
		resolvedInstructions,
		deterministicFacts
	})
	debugLog("changelogPipeline:pass1", { notes: mechanical.notes.length })

	const DEFAULT_GLOBAL_HUNK_BUDGET_BYTES = 256 * 1024
	let remainingBytes = DEFAULT_GLOBAL_HUNK_BUDGET_BYTES
	const allowedHunkIds = new Set(Object.values(evidence).flatMap((e) => e.hunkIds))

	const DEFAULT_GLOBAL_REPO_SNIPPET_BUDGET_BYTES = 192 * 1024
	let remainingRepoBytes = DEFAULT_GLOBAL_REPO_SNIPPET_BUDGET_BYTES

	const DEFAULT_GLOBAL_REPO_SEARCH_BUDGET_BYTES = 96 * 1024
	let remainingSearchBytes = DEFAULT_GLOBAL_REPO_SEARCH_BUDGET_BYTES

	const DEFAULT_GLOBAL_REPO_TEXT_SEARCH_BUDGET_BYTES = 128 * 1024
	let remainingRepoTextSearchBytes = DEFAULT_GLOBAL_REPO_TEXT_SEARCH_BUDGET_BYTES

	const DEFAULT_GLOBAL_REPO_LIST_BUDGET_BYTES = 48 * 1024
	let remainingRepoListBytes = DEFAULT_GLOBAL_REPO_LIST_BUDGET_BYTES

	const DEFAULT_GLOBAL_REPO_PATH_SEARCH_BUDGET_BYTES = 48 * 1024
	let remainingRepoPathSearchBytes = DEFAULT_GLOBAL_REPO_PATH_SEARCH_BUDGET_BYTES

	const DEFAULT_GLOBAL_REPO_META_BUDGET_BYTES = 48 * 1024
	let remainingRepoMetaBytes = DEFAULT_GLOBAL_REPO_META_BUDGET_BYTES

	const semantic = await params.llmClient.pass2Semantic(
		{ base: params.base, mechanical, evidence, resolvedInstructions },
		{
			getDiffHunks: async (hunkIds) => {
				for (const id of hunkIds) {
					if (!allowedHunkIds.has(id)) throw new Error(`Unknown hunk id (not in evidence index): ${id}`)
				}
				if (remainingBytes <= 0) throw new Error("LLM hunk budget exhausted")
				const hunks = await getDiffHunks({
					base: params.base,
					hunkIds,
					cwd,
					maxTotalBytes: remainingBytes
				})
				const used = hunks.reduce((sum: number, h: DiffHunk) => sum + (h.byteLength ?? 0), 0)
				remainingBytes -= used
				return hunks
			},
			getRepoFileSnippets: async (requests) => {
				if (remainingRepoBytes <= 0) throw new Error("LLM repo context budget exhausted")
				const snippets = await getRepoFileSnippets({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoBytes,
					maxSnippetBytes: 16 * 1024,
					maxSnippetLines: 200
				})
				const used = snippets.reduce((sum, s) => sum + (s.byteLength ?? 0), 0)
				remainingRepoBytes -= used
				return snippets
			},
			getRepoSnippetAround: async (requests) => {
				if (remainingRepoBytes <= 0) throw new Error("LLM repo context budget exhausted")
				const snippets = await getRepoSnippetAround({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoBytes,
					maxSnippetBytes: 16 * 1024,
					maxSnippetLines: 200,
					maxContextLines: 80
				})
				const used = snippets.reduce((sum, s) => sum + (s.byteLength ?? 0), 0)
				remainingRepoBytes -= used
				return snippets
			},
			getRepoFileMeta: async (requests) => {
				if (remainingRepoMetaBytes <= 0) throw new Error("LLM repo file meta budget exhausted")
				const meta = await getRepoFileMeta({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoMetaBytes,
					maxFilesPerRequest: 50,
					maxProbeBytesPerFile: 8 * 1024,
					maxLineCountBytesPerFile: 256 * 1024
				})
				const used = meta.reduce((sum, m) => sum + (m.byteLength ?? 0), 0)
				remainingRepoMetaBytes -= used
				return meta
			},
			searchRepoFiles: async (requests) => {
				if (remainingSearchBytes <= 0) throw new Error("LLM repo search budget exhausted")
				const results = await searchRepoFiles({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingSearchBytes,
					maxResultBytes: 16 * 1024,
					maxMatchesPerRequest: 50
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingSearchBytes -= used
				return results
			},
			searchRepoText: async (requests) => {
				if (remainingRepoTextSearchBytes <= 0) throw new Error("LLM repo-wide search budget exhausted")
				const results = await searchRepoText({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoTextSearchBytes,
					maxResultBytes: 24 * 1024,
					maxMatchesPerRequest: 100,
					maxFilesPerRequest: 200
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingRepoTextSearchBytes -= used
				return results
			},
			listRepoFiles: async (requests) => {
				if (remainingRepoListBytes <= 0) throw new Error("LLM repo file listing budget exhausted")
				const results = await listRepoFiles({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoListBytes,
					maxFilesPerRequest: 500
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingRepoListBytes -= used
				return results
			},
			searchRepoPaths: async (requests) => {
				if (remainingRepoPathSearchBytes <= 0) throw new Error("LLM repo path search budget exhausted")
				const results = await searchRepoPaths({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoPathSearchBytes,
					maxFilesPerRequest: 1000
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingRepoPathSearchBytes -= used
				return results
			}
		}
	)
	debugLog("changelogPipeline:pass2", { notes: semantic.notes.length })

	const editorial = await params.llmClient.pass3Editorial({ mechanical, semantic, evidence, resolvedInstructions })
	debugLog("changelogPipeline:pass3")

	function repairBulletEvidenceIds(text: string, ids: string[]): string[] {
		const known = ids
			.map((s) => s.trim())
			.filter(Boolean)
			.filter((id) => !!evidence[id])
		if (known.length) return [...new Set(known)].sort(compareStrings)

		// Infer evidence IDs from file paths mentioned in the bullet text.
		const candidates = Object.values(evidence).filter((e) => {
			return (
				(text.includes(e.filePath) || (e.oldPath ? text.includes(e.oldPath) : false)) &&
				// Keep inference conservative: only infer for non-binary evidence.
				!e.isBinary
			)
		})
		if (!candidates.length) return []
		return [...new Set(candidates.map((c) => c.id))].sort(compareStrings)
	}

	function repairBullets<T extends { text: string; evidenceNodeIds: string[] }>(bullets: T[]): T[] {
		const repaired: T[] = []
		const seenText = new Set<string>()
		for (const b of bullets) {
			const text = (b.text ?? "").trim().replace(/\s+/g, " ")
			if (!text) continue
			// Dedupe by normalized text (cheap, deterministic quality win).
			const textKey = text.toLowerCase()
			if (seenText.has(textKey)) continue
			seenText.add(textKey)

			const repairedIds = repairBulletEvidenceIds(text, b.evidenceNodeIds)
			if (!repairedIds.length) continue
			repaired.push({ ...b, text, evidenceNodeIds: repairedIds })
		}
		return repaired
	}

	function surfaceRank(surface: string): number {
		// Higher-signal surfaces first.
		switch (surface) {
			case "public-api":
				return 0
			case "cli":
				return 1
			case "config":
				return 2
			case "infra":
				return 3
			case "docs":
				return 4
			case "tests":
				return 5
			case "internal":
				return 6
			default:
				return 99
		}
	}

	function bulletSortKey(b: { text: string; evidenceNodeIds: string[] }): {
		surface: number
		filePath: string
		text: string
	} {
		const nodes = b.evidenceNodeIds
			.map((id) => evidence[id])
			.filter(Boolean)
			.sort((a, c) => compareStrings(a.filePath, c.filePath) || compareStrings(a.id, c.id))
		const primary = nodes[0]
		return {
			surface: primary ? surfaceRank(primary.surface) : 99,
			filePath: primary ? primary.filePath : "",
			text: b.text
		}
	}

	function sortBullets<T extends { text: string; evidenceNodeIds: string[] }>(bullets: T[]): T[] {
		return [...bullets].sort((a, b) => {
			const ka = bulletSortKey(a)
			const kb = bulletSortKey(b)
			return (
				ka.surface - kb.surface || compareStrings(ka.filePath, kb.filePath) || compareStrings(ka.text, kb.text)
			)
		})
	}

	const repairedEditorial: ChangelogModel = {
		...editorial,
		evidence: {},
		breakingChanges: repairBullets(editorial.breakingChanges),
		added: repairBullets(editorial.added),
		changed: repairBullets(editorial.changed),
		fixed: repairBullets(editorial.fixed),
		removed: repairBullets(editorial.removed),
		internalTooling: repairBullets(editorial.internalTooling)
	}

	// Inject evidence deterministically and stabilize ordering.
	const stabilized: ChangelogModel = {
		...repairedEditorial,
		evidence,
		breakingChanges: sortBullets(
			repairedEditorial.breakingChanges.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		),
		added: sortBullets(
			repairedEditorial.added.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		),
		changed: sortBullets(
			repairedEditorial.changed.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		),
		fixed: sortBullets(
			repairedEditorial.fixed.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		),
		removed: sortBullets(
			repairedEditorial.removed.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		),
		internalTooling: sortBullets(
			repairedEditorial.internalTooling.map((b) => ({ ...b, evidenceNodeIds: [...b.evidenceNodeIds].sort() }))
		)
	}

	const validation = validateChangelogModel(stabilized)
	if (!validation.ok) throw new Error(`LLM changelog model validation failed:\n${validation.errors.join("\n")}`)

	// Human-friendly markdown rendering:
	// - Single flat list (no empty sections)
	// - Deterministic ordering by section priority + stable bullet sorting above
	const orderedBullets = [
		...stabilized.breakingChanges,
		...stabilized.added,
		...stabilized.changed,
		...stabilized.fixed,
		...stabilized.removed,
		...stabilized.internalTooling
	]

	const baseDisplay = (params.baseLabel ?? "").trim() || indexRes.baseSha
	const headDisplay = (params.headLabel ?? "").trim() || indexRes.headSha
	const lines: string[] = [`# Changelog (${baseDisplay}..${headDisplay})`]
	if (orderedBullets.length) {
		lines.push("")
		for (const b of orderedBullets) lines.push(`- ${b.text}`)
	}
	const markdown = lines.join("\n")

	// This runner does not render markdown for LLM mode yet; callers can render
	// from the returned model. We return the index path for auditability.
	return { markdown, model: stabilized }
}
