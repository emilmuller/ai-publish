import { join } from "node:path"
import { runGitOrThrow } from "../git/runGit"
import { ensureDir, writeFileAtomic } from "../util/fs"
import { getDiffSummary } from "./getDiffSummary"
import { indexUnifiedDiffToDir } from "./unifiedDiffIndexer"
import type { IndexDiffResult } from "./types"

export async function indexDiff(params: {
	base: string
	cwd?: string
	indexRootDir?: string
	limits?: { maxHunkBytes?: number; maxTotalHunkBytes?: number }
}): Promise<IndexDiffResult> {
	const cwd = params.cwd ?? process.cwd()

	const baseSha = (await runGitOrThrow(["rev-parse", params.base], { cwd })).trim()
	const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd })).trim()

	const indexRootDir = params.indexRootDir ?? join(cwd, ".ai-publish", "diff-index")
	const indexKey = `${baseSha}..${headSha}`
	const indexDir = join(indexRootDir, indexKey)

	await ensureDir(indexDir)

	const limits = {
		maxHunkBytes: params.limits?.maxHunkBytes ?? 48 * 1024,
		maxTotalHunkBytes: params.limits?.maxTotalHunkBytes ?? 10 * 1024 * 1024
	}

	const summary = await getDiffSummary(baseSha, { cwd })

	const indexed = await indexUnifiedDiffToDir({
		cwd,
		baseSha,
		headSha,
		indexDir,
		limits
	})

	summary.totalHunks = indexed.totalHunks

	const manifestPath = join(indexDir, "manifest.json")
	await writeFileAtomic(manifestPath, JSON.stringify(indexed.manifest, null, 2))

	return {
		baseSha,
		headSha,
		indexDir,
		manifest: indexed.manifest,
		manifestPath,
		summary
	}
}
