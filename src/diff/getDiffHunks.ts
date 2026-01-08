import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { runGitOrThrow } from "../git/runGit"
import type { DiffHunk } from "./types"

export async function getDiffHunks(params: {
	base: string
	hunkIds: string[]
	cwd?: string
	indexRootDir?: string
	maxTotalBytes?: number
}): Promise<DiffHunk[]> {
	const cwd = params.cwd ?? process.cwd()

	const baseSha = (await runGitOrThrow(["rev-parse", params.base], { cwd })).trim()
	const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd })).trim()

	const indexRootDir = params.indexRootDir ?? join(cwd, ".ai-publish", "diff-index")
	const indexKey = `${baseSha}..${headSha}`
	const hunkDir = join(indexRootDir, indexKey, "hunks")

	const maxTotalBytes = params.maxTotalBytes ?? 256 * 1024

	let totalBytes = 0
	const results: DiffHunk[] = []

	for (const id of params.hunkIds) {
		if (!/^[0-9a-f]{64}$/i.test(id)) {
			throw new Error(`Invalid hunk id: ${id}`)
		}

		const p = join(hunkDir, `${id}.patch`)
		let buf: Buffer
		try {
			buf = await readFile(p)
		} catch (err: unknown) {
			const code =
				err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code != null
					? ` (${String((err as { code?: unknown }).code)})`
					: ""
			throw new Error(`Failed to read hunk file for id ${id}${code}: ${p}`)
		}
		const byteLength = buf.byteLength
		totalBytes += buf.byteLength
		if (totalBytes > maxTotalBytes) {
			throw new Error(`Requested hunks exceed maxTotalBytes (${maxTotalBytes}).`)
		}

		const text = buf.toString("utf8")
		const lines = text.split(/\r?\n/)

		// Format written by indexer:
		// file: <path>
		// oldFile: <path> (optional)
		// @@ ... @@
		// ...
		let i = 0
		const fileLine = lines[i++] ?? ""
		const fileMatch = /^file:\s+(.*)$/.exec(fileLine)
		const filePath = (fileMatch?.[1] ?? "").trim()
		if (!filePath) {
			throw new Error(
				`Invalid hunk file format for id ${id}: expected first line 'file: <path>' but got '${fileLine.slice(
					0,
					80
				)}'`
			)
		}

		let oldPath: string | undefined
		if ((lines[i] ?? "").startsWith("oldFile: ")) {
			oldPath = (lines[i] ?? "").slice("oldFile: ".length).trim()
			if (!oldPath) {
				throw new Error(`Invalid hunk file format for id ${id}: 'oldFile:' line is empty`)
			}
			i += 1
		}

		const header = lines[i++] ?? ""
		if (!header.startsWith("@@ ")) {
			throw new Error(
				`Invalid hunk file format for id ${id}: expected hunk header starting with '@@ ' but got '${header.slice(
					0,
					80
				)}'`
			)
		}
		const hunkLines = lines.slice(i)

		const isTruncated = hunkLines.some((l: string) => l.includes("truncated hunk (ai-publish)"))

		results.push({
			id,
			filePath,
			oldPath,
			header,
			lines: hunkLines,
			isTruncated,
			byteLength
		})
	}

	return results
}
