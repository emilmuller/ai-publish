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

export async function runReleaseNotesPipeline(params: {
	base: string
	/** Optional label for rendering output (does not affect diff authority). */
	baseLabel?: string
	/** Optional label for rendering output (does not affect diff authority). */
	headLabel?: string
	cwd?: string
	llmClient: LLMClient
}): Promise<{ markdown: string; releaseNotes: ReleaseNotesOutput }> {
	const cwd = params.cwd ?? process.cwd()

	// Always build the diff index first; it is the queryable authority.
	const indexRes = await indexDiff({ base: params.base, cwd })

	// LLM mode: follow the same 3-pass contract and tool-gating as changelog.
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

	const out = await params.llmClient.pass3ReleaseNotes({ mechanical, semantic, evidence, resolvedInstructions })

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
	const baseDisplay = (params.baseLabel ?? "").trim() || indexRes.baseSha
	const headDisplay = (params.headLabel ?? "").trim() || indexRes.headSha
	const lines: string[] = [`# Release Notes (${baseDisplay}..${headDisplay})`]
	if (body) {
		lines.push("")
		lines.push(body)
	}
	const markdown = lines.join("\n") + "\n"

	return { markdown, releaseNotes: { markdown: body, evidenceNodeIds: finalEvidenceNodeIds } }
}
