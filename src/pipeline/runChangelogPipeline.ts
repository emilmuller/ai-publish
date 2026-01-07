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
import { runGitOrThrow } from "../git/runGit"
import { getCommitContext } from "../git/getCommitContext"
import { renderKeepAChangelogMarkdown } from "../changelog/renderKeepAChangelog"
import { detectBreakingChanges } from "../changelog/breaking"
import { logDebug, logInfo, traceToolsEnabled } from "../util/logger"

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
	/**
	 * Optional bounded git commit message context (untrusted, non-authoritative).
	 * CLI defaults to a bounded snippet mode; consumers may disable it.
	 */
	commitContext?: {
		mode: "none" | "snippet" | "full"
		maxCommits?: number
		maxTotalBytes?: number
		maxBodyBytesPerCommit?: number
	}
}): Promise<{ markdown: string; model: ChangelogModel }> {
	const cwd = params.cwd ?? process.cwd()
	logInfo("changelog:start", { base: params.base, baseLabel: params.baseLabel, headLabel: params.headLabel })
	debugLog("changelogPipeline", { base: params.base, cwd })

	async function getHeadCommitDateISO(headSha: string): Promise<string> {
		// Deterministic (commit date), date portion: YYYY-MM-DD
		const out = await runGitOrThrow(["show", "-s", "--format=%cs", headSha], { cwd })
		return out.trim()
	}

	function isMaxTotalBytesExceededError(err: unknown): boolean {
		const msg = (err as any)?.message
		return typeof msg === "string" && msg.includes("Requested hunks exceed maxTotalBytes")
	}

	// Always build the diff index first; it is the queryable authority.
	debugLog("changelogPipeline:indexDiff")
	const indexRes = await indexDiff({ base: params.base, cwd })
	logInfo("changelog:indexed", {
		baseSha: indexRes.baseSha,
		headSha: indexRes.headSha,
		files: indexRes.summary.files.length
	})
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

	const commitContext =
		params.commitContext && params.commitContext.mode !== "none"
			? await getCommitContext({
					cwd,
					baseSha: indexRes.baseSha,
					headSha: indexRes.headSha,
					mode: params.commitContext.mode,
					maxCommits: params.commitContext.maxCommits,
					maxTotalBytes: params.commitContext.maxTotalBytes,
					maxBodyBytesPerCommit: params.commitContext.maxBodyBytesPerCommit
			  })
			: undefined

	const mechanical = await params.llmClient.pass1Mechanical({
		base: params.base,
		diffSummary,
		diffIndexManifest,
		evidence,
		resolvedInstructions,
		deterministicFacts
	})
	debugLog("changelogPipeline:pass1", { notes: mechanical.notes.length })
	logInfo("changelog:pass1", { notes: mechanical.notes.length })

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
		{ base: params.base, mechanical, evidence, resolvedInstructions, commitContext },
		{
			getDiffHunks: async (hunkIds) => {
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:getDiffHunks", { requested: hunkIds.length, remainingBytes })
				const unknown = hunkIds.filter((id) => !allowedHunkIds.has(id))
				if (unknown.length) {
					debugLog("changelogPipeline:semantic:unknownHunkIds", {
						count: unknown.length,
						sample: unknown.slice(0, 5)
					})
				}
				const allowed = hunkIds.filter((id) => allowedHunkIds.has(id))
				if (!allowed.length) return []
				if (remainingBytes <= 0) throw new Error("LLM hunk budget exhausted")

				// The model may over-request hunks. Enforce the global budget by
				// deterministically downsizing/chunking requests instead of failing the run.
				const collected: DiffHunk[] = []
				let cursor = 0

				while (cursor < allowed.length) {
					if (remainingBytes <= 0) break
					let chunkSize = Math.min(12, allowed.length - cursor)

					while (chunkSize > 0) {
						const chunkIds = allowed.slice(cursor, cursor + chunkSize)
						try {
							const hunks = await getDiffHunks({
								base: params.base,
								hunkIds: chunkIds,
								cwd,
								maxTotalBytes: remainingBytes
							})
							collected.push(...hunks)
							const used = hunks.reduce((sum: number, h: DiffHunk) => sum + (h.byteLength ?? 0), 0)
							remainingBytes -= used
							if (trace)
								logInfo("tool:getDiffHunks:chunk", {
									returned: hunks.length,
									usedBytes: used,
									remainingBytes
								})
							cursor += chunkSize
							break
						} catch (err) {
							if (isMaxTotalBytesExceededError(err)) {
								// Reduce chunk size until it fits the remaining budget.
								if (chunkSize === 1) {
									// Should be rare (our per-hunk storage is bounded), but don't fail the run.
									debugLog("changelogPipeline:semantic:hunkBudgetSkip", {
										id: chunkIds[0],
										remainingBytes
									})
									if (trace) logInfo("tool:getDiffHunks:skip", { remainingBytes })
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
				if (trace) logInfo("tool:getDiffHunks:result", { returned: collected.length, remainingBytes })

				return collected
			},
			getRepoFileSnippets: async (requests) => {
				if (remainingRepoBytes <= 0) throw new Error("LLM repo context budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:getRepoFileSnippets", { requests: requests.length, remainingRepoBytes })
				let snippets: any[] = []
				try {
					snippets = await getRepoFileSnippets({
						cwd,
						ref: indexRes.headSha,
						requests,
						maxTotalBytes: remainingRepoBytes,
						maxSnippetBytes: 16 * 1024,
						maxSnippetLines: 200
					})
				} catch (e) {
					debugLog("changelogPipeline:semantic:repoSnippetsFailed", {
						error: (e as Error)?.message ?? String(e)
					})
					logDebug("tool:getRepoFileSnippets:failed", { error: (e as Error)?.message ?? String(e) })
					return []
				}
				const used = snippets.reduce((sum, s) => sum + (s.byteLength ?? 0), 0)
				remainingRepoBytes -= used
				if (trace)
					logInfo("tool:getRepoFileSnippets:result", {
						returned: snippets.length,
						usedBytes: used,
						remainingRepoBytes
					})
				return snippets
			},
			getRepoSnippetAround: async (requests) => {
				if (remainingRepoBytes <= 0) throw new Error("LLM repo context budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:getRepoSnippetAround", { requests: requests.length, remainingRepoBytes })
				let snippets: any[] = []
				try {
					snippets = await getRepoSnippetAround({
						cwd,
						ref: indexRes.headSha,
						requests,
						maxTotalBytes: remainingRepoBytes,
						maxSnippetBytes: 16 * 1024,
						maxSnippetLines: 200,
						maxContextLines: 80
					})
				} catch (e) {
					debugLog("changelogPipeline:semantic:repoSnippetAroundFailed", {
						error: (e as Error)?.message ?? String(e)
					})
					logDebug("tool:getRepoSnippetAround:failed", { error: (e as Error)?.message ?? String(e) })
					return []
				}
				const used = snippets.reduce((sum, s) => sum + (s.byteLength ?? 0), 0)
				remainingRepoBytes -= used
				if (trace)
					logInfo("tool:getRepoSnippetAround:result", {
						returned: snippets.length,
						usedBytes: used,
						remainingRepoBytes
					})
				return snippets
			},
			getRepoFileMeta: async (requests) => {
				if (remainingRepoMetaBytes <= 0) throw new Error("LLM repo file meta budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:getRepoFileMeta", { requests: requests.length, remainingRepoMetaBytes })
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
				if (trace)
					logInfo("tool:getRepoFileMeta:result", {
						returned: meta.length,
						usedBytes: used,
						remainingRepoMetaBytes
					})
				return meta
			},
			searchRepoFiles: async (requests) => {
				if (remainingSearchBytes <= 0) throw new Error("LLM repo search budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:searchRepoFiles", { requests: requests.length, remainingSearchBytes })
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
				if (trace)
					logInfo("tool:searchRepoFiles:result", {
						returned: results.length,
						usedBytes: used,
						remainingSearchBytes
					})
				return results
			},
			searchRepoText: async (requests) => {
				if (remainingRepoTextSearchBytes <= 0) throw new Error("LLM repo-wide search budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:searchRepoText", { requests: requests.length, remainingRepoTextSearchBytes })
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
				if (trace)
					logInfo("tool:searchRepoText:result", {
						returned: results.length,
						usedBytes: used,
						remainingRepoTextSearchBytes
					})
				return results
			},
			listRepoFiles: async (requests) => {
				if (remainingRepoListBytes <= 0) throw new Error("LLM repo file listing budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:listRepoFiles", { requests: requests.length, remainingRepoListBytes })
				const results = await listRepoFiles({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoListBytes,
					maxFilesPerRequest: 500
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingRepoListBytes -= used
				if (trace)
					logInfo("tool:listRepoFiles:result", {
						returned: results.length,
						usedBytes: used,
						remainingRepoListBytes
					})
				return results
			},
			searchRepoPaths: async (requests) => {
				if (remainingRepoPathSearchBytes <= 0) throw new Error("LLM repo path search budget exhausted")
				const trace = traceToolsEnabled()
				if (trace) logInfo("tool:searchRepoPaths", { requests: requests.length, remainingRepoPathSearchBytes })
				const results = await searchRepoPaths({
					cwd,
					ref: indexRes.headSha,
					requests,
					maxTotalBytes: remainingRepoPathSearchBytes,
					maxFilesPerRequest: 1000
				})
				const used = results.reduce((sum, r) => sum + (r.byteLength ?? 0), 0)
				remainingRepoPathSearchBytes -= used
				if (trace)
					logInfo("tool:searchRepoPaths:result", {
						returned: results.length,
						usedBytes: used,
						remainingRepoPathSearchBytes
					})
				return results
			}
		}
	)
	debugLog("changelogPipeline:pass2", { notes: semantic.notes.length })

	const editorial = await params.llmClient.pass3Editorial({
		mechanical,
		semantic,
		evidence,
		resolvedInstructions,
		commitContext
	})
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

	// Deterministic breaking-change heuristics (evidence-backed).
	// This reduces dependence on the LLM correctly flagging breaking changes in every run.
	try {
		const heuristicBreaking = await detectBreakingChanges({ base: params.base, cwd, evidence })
		if (heuristicBreaking.length) {
			repairedEditorial.breakingChanges = repairBullets([
				...repairedEditorial.breakingChanges,
				...heuristicBreaking
			])
		}
	} catch (e) {
		debugLog("changelogPipeline:heuristicBreaking:failed", { error: (e as Error)?.message ?? String(e) })
	}

	function referencedEvidenceNodeIds(
		model: Pick<ChangelogModel, keyof Omit<ChangelogModel, "evidence">>
	): Set<string> {
		const ids = new Set<string>()
		for (const b of model.breakingChanges) for (const id of b.evidenceNodeIds) ids.add(id)
		for (const b of model.added) for (const id of b.evidenceNodeIds) ids.add(id)
		for (const b of model.changed) for (const id of b.evidenceNodeIds) ids.add(id)
		for (const b of model.fixed) for (const id of b.evidenceNodeIds) ids.add(id)
		for (const b of model.removed) for (const id of b.evidenceNodeIds) ids.add(id)
		for (const b of model.internalTooling) for (const id of b.evidenceNodeIds) ids.add(id)
		return ids
	}

	function isInternalSurface(surface: string): boolean {
		return surface === "internal" || surface === "tests" || surface === "infra"
	}

	function sectionForAutoBullet(node: {
		surface: string
		changeType: string
	}): "added" | "changed" | "removed" | "internalTooling" {
		if (isInternalSurface(node.surface)) return "internalTooling"
		if (node.changeType === "add") return "added"
		if (node.changeType === "delete") return "removed"
		return "changed"
	}

	function autoBulletText(node: {
		filePath: string
		oldPath?: string
		changeType: string
		isBinary: boolean
	}): string {
		const fp = node.filePath
		const op = node.oldPath
		const binaryPrefix = node.isBinary ? "binary file " : ""
		switch (node.changeType) {
			case "add":
				return `Added ${binaryPrefix}${fp}.`
			case "delete":
				return `Removed ${binaryPrefix}${fp}.`
			case "rename":
				return op ? `Renamed ${binaryPrefix}${op} to ${fp}.` : `Renamed ${binaryPrefix}${fp}.`
			case "copy":
				return op ? `Copied ${binaryPrefix}${op} to ${fp}.` : `Copied ${binaryPrefix}${fp}.`
			default:
				return `Updated ${binaryPrefix}${fp}.`
		}
	}

	// Coverage guardrail: ensure every evidence node is referenced by at least one bullet.
	// This enforces the user's expectation: changelog covers the entire base..HEAD diff.
	const referenced = referencedEvidenceNodeIds(repairedEditorial)
	const missingNodes = Object.values(evidence)
		.filter((n) => !referenced.has(n.id))
		.sort((a, b) => {
			return (
				surfaceRank(a.surface) - surfaceRank(b.surface) ||
				compareStrings(a.filePath, b.filePath) ||
				compareStrings(a.id, b.id)
			)
		})
	if (missingNodes.length && debugEnabled()) {
		debugLog("changelogPipeline:coverage:missingEvidenceNodes", {
			count: missingNodes.length,
			sample: missingNodes.slice(0, 5).map((n) => ({ id: n.id, filePath: n.filePath, surface: n.surface }))
		})
	}
	for (const node of missingNodes) {
		const section = sectionForAutoBullet(node)
		const text = autoBulletText(node)
		const bullet = { text, evidenceNodeIds: [node.id] }
		if (section === "added") repairedEditorial.added.push(bullet)
		else if (section === "removed") repairedEditorial.removed.push(bullet)
		else if (section === "internalTooling") repairedEditorial.internalTooling.push(bullet)
		else repairedEditorial.changed.push(bullet)
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

	// Consumer-facing markdown rendering (Keep a Changelog style).
	// Authoritative evidence remains in the returned model.
	const releaseDateISO = await getHeadCommitDateISO(indexRes.headSha)
	const markdown = renderKeepAChangelogMarkdown({
		model: stabilized,
		versionLabel: params.headLabel,
		releaseDateISO
	})

	// This runner does not render markdown for LLM mode yet; callers can render
	// from the returned model. We return the index path for auditability.
	return { markdown, model: stabilized }
}
