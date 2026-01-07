import { indexDiff, getDiffHunks } from "../diff"
import { getResolvedInstructions } from "../instructions/resolveInstructions"
import type { LLMClient, ReleaseNotesOutput } from "../llm/types"
import type { DiffIndexManifest, DiffHunk } from "../diff/types"
import { buildEvidenceFromManifest } from "../changelog/evidence"
import { buildDeterministicMechanicalFacts } from "../llm/deterministicFacts"
import { getRepoFileSnippets } from "../repo/getRepoFileSnippets"
import { getRepoSnippetAround } from "../repo/getRepoSnippetAround"
import { getRepoFileMeta } from "../repo/getRepoFileMeta"
import { searchRepoFiles } from "../repo/searchRepoFiles"
import { searchRepoPaths } from "../repo/searchRepoPaths"
import { searchRepoText } from "../repo/searchRepoText"
import { listRepoFiles } from "../repo/listRepoFiles"
import { renderReleaseNotesMarkdown } from "../releaseNotes/renderReleaseNotes"
import { resolveHeadVersionTagFromGitTags } from "../version/resolveVersionBase"
import { getCommitContext } from "../git/getCommitContext"
import { logDebug, logInfo, traceToolsEnabled } from "../util/logger"

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1"
}

function debugLog(...args: any[]) {
	if (!debugEnabled()) return
	// eslint-disable-next-line no-console
	console.error("[ai-publish][debug]", ...args)
}

function isMaxTotalBytesExceededError(err: unknown): boolean {
	const msg = (err as any)?.message
	return typeof msg === "string" && msg.includes("Requested hunks exceed maxTotalBytes")
}

export async function runReleaseNotesPipeline(params: {
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
}): Promise<{ markdown: string; releaseNotes: ReleaseNotesOutput }> {
	const cwd = params.cwd ?? process.cwd()
	logInfo("releaseNotes:start", { base: params.base, baseLabel: params.baseLabel, headLabel: params.headLabel })

	// Always build the diff index first; it is the queryable authority.
	const indexRes = await indexDiff({ base: params.base, cwd })
	logInfo("releaseNotes:indexed", {
		baseSha: indexRes.baseSha,
		headSha: indexRes.headSha,
		files: indexRes.summary.files.length
	})

	// LLM mode: follow the same 3-pass contract and tool-gating as changelog.
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
	logInfo("releaseNotes:pass1", { notes: mechanical.notes.length })

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
					debugLog("releaseNotesPipeline:semantic:unknownHunkIds", {
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
									debugLog("releaseNotesPipeline:semantic:hunkBudgetSkip", {
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
					debugLog("releaseNotesPipeline:semantic:repoSnippetsFailed", {
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
					debugLog("releaseNotesPipeline:semantic:repoSnippetAroundFailed", {
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
	logInfo("releaseNotes:pass2", { notes: semantic.notes.length })

	const out = await params.llmClient.pass3ReleaseNotes({
		mechanical,
		semantic,
		evidence,
		resolvedInstructions,
		commitContext
	})
	logInfo("releaseNotes:pass3", { evidenceNodeIds: out.evidenceNodeIds.length, markdownChars: out.markdown.length })

	// Prefer an exact version tag pointing at HEAD when the caller didn't provide a stable label.
	// This avoids emitting "Unreleased" for already-tagged releases.
	let versionLabelForRender = (params.headLabel ?? "").trim()
	if (
		!versionLabelForRender ||
		versionLabelForRender.toUpperCase() === "HEAD" ||
		/^[0-9a-f]{7,40}$/i.test(versionLabelForRender)
	) {
		const head = await resolveHeadVersionTagFromGitTags({ cwd, tagPrefix: "v" })
		if (head.headTag) versionLabelForRender = head.headTag
	}

	const requestedEvidenceNodeIds = [...new Set(out.evidenceNodeIds)].map((s) => s.trim()).filter(Boolean)
	const evidenceNodeIds = requestedEvidenceNodeIds.filter((id) => !!evidence[id]).sort()

	const body = out.markdown.trim()
	if (body && evidenceNodeIds.length === 0) {
		throw new Error(
			"Release notes output contained markdown but no valid evidenceNodeIds. Refusing to attach all evidence implicitly; re-run with a better LLM output."
		)
	}
	// Empty markdown is allowed (no user-facing change to report).
	const finalEvidenceNodeIds = evidenceNodeIds.length ? evidenceNodeIds : []
	const rendered = renderReleaseNotesMarkdown({ versionLabel: versionLabelForRender, bodyMarkdown: body })
	return {
		markdown: rendered.markdown,
		releaseNotes: { markdown: rendered.bodyMarkdown, evidenceNodeIds: finalEvidenceNodeIds }
	}
}
