import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { sha256Hex } from "../util/sha256"
import { compareStrings } from "../util/compare"
import type { DiffChangeType, DiffIndexManifest } from "./types"

export type IndexerLimits = {
	maxHunkBytes: number
	maxTotalHunkBytes: number
}

export type IndexerResult = {
	manifest: DiffIndexManifest
	hunkDir: string
	totalHunks: number
}

type FilePatch = {
	path: string
	oldPath?: string
	changeType: DiffChangeType
	isBinary: boolean
	hunkIds: string[]
}

function normalizePathFromDiff(raw: string): string {
	// diff paths are usually like a/foo or b/foo. We store without the prefix.
	return raw.replace(/^[ab]\//, "")
}

function isHunkHeader(line: string): boolean {
	return line.startsWith("@@ ")
}

function isFileHeader(line: string): boolean {
	return line.startsWith("diff --git ")
}

export async function indexUnifiedDiffToDir(params: {
	cwd: string
	baseSha: string
	headSha: string
	indexDir: string
	limits: IndexerLimits
}): Promise<IndexerResult> {
	const { cwd, baseSha, headSha, indexDir, limits } = params
	const hunkDir = join(indexDir, "hunks")
	await mkdir(hunkDir, { recursive: true })

	const manifest: DiffIndexManifest = {
		schemaVersion: 1,
		baseSha,
		headSha,
		files: []
	}

	const child = spawn(
		"git",
		["diff", "--no-color", "--patch", "-U3", "-M", "--find-renames", `${baseSha}..${headSha}`],
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true
		}
	)

	// Attach exit handlers immediately to avoid missing a fast "close" event.
	const closePromise: Promise<number> = new Promise((resolve, reject) => {
		child.on("error", reject)
		child.on("close", (code) => resolve(code ?? 0))
	})

	child.stdout.setEncoding("utf8")

	let stderr = ""
	child.stderr.setEncoding("utf8")
	child.stderr.on("data", (chunk: string) => {
		// Keep stderr bounded.
		if (stderr.length < 128 * 1024) stderr += chunk.slice(0, 128 * 1024 - stderr.length)
	})

	const files: FilePatch[] = []

	let currentFile: FilePatch | null = null

	let currentHunkLines: string[] | null = null
	let currentHunkHeader: string | null = null
	let currentHunkBytes = 0
	let currentHunkTruncated = false

	let totalHunkBytes = 0
	let totalHunks = 0

	async function flushHunk(): Promise<void> {
		if (!currentFile || !currentHunkLines || !currentHunkHeader) return

		const content = [
			`file: ${currentFile.path}`,
			...(currentFile.oldPath ? [`oldFile: ${currentFile.oldPath}`] : []),
			currentHunkHeader,
			...currentHunkLines
		].join("\n")

		const hunkId = sha256Hex(content)

		const hunkPath = join(hunkDir, `${hunkId}.patch`)

		// Enforce total byte limits based on what we write to disk (including headers).
		const contentBytes = Buffer.byteLength(content, "utf8")
		totalHunkBytes += contentBytes
		if (totalHunkBytes > limits.maxTotalHunkBytes) {
			throw new Error(`Diff index exceeds maxTotalHunkBytes (${limits.maxTotalHunkBytes}).`)
		}

		// We always store the bounded representation; truncation is represented by a marker line.
		await writeFile(hunkPath, content, { encoding: "utf8" })

		currentFile.hunkIds.push(hunkId)
		totalHunks += 1

		currentHunkLines = null
		currentHunkHeader = null
		currentHunkBytes = 0
		currentHunkTruncated = false
	}

	async function writeMetaEvidenceHunk(file: FilePatch): Promise<void> {
		// For rename/copy-only or other hunkless diffs, create a metadata-only evidence node.
		// This keeps the overall system auditable without exposing full diffs.
		const metaLines = [
			`changeType: ${file.changeType}`,
			...(file.oldPath ? [`oldPath: ${file.oldPath}`] : []),
			`path: ${file.path}`,
			`isBinary: ${file.isBinary}`
		]
		const content = [
			`file: ${file.path}`,
			...(file.oldPath ? [`oldFile: ${file.oldPath}`] : []),
			"@@ meta @@",
			...metaLines
		].join("\n")

		const hunkId = sha256Hex(content)
		const hunkPath = join(hunkDir, `${hunkId}.patch`)

		const contentBytes = Buffer.byteLength(content, "utf8")
		totalHunkBytes += contentBytes
		if (totalHunkBytes > limits.maxTotalHunkBytes) {
			throw new Error(`Diff index exceeds maxTotalHunkBytes (${limits.maxTotalHunkBytes}).`)
		}

		await writeFile(hunkPath, content, { encoding: "utf8" })
		file.hunkIds.push(hunkId)
		totalHunks += 1
	}

	async function flushFile(): Promise<void> {
		await flushHunk()
		if (currentFile) {
			if (currentFile.hunkIds.length === 0) {
				await writeMetaEvidenceHunk(currentFile)
			}
			files.push(currentFile)
		}
		currentFile = null
	}

	function beginFileFromHeader(line: string): void {
		// diff --git a/foo b/bar
		const parts = line.split(" ")
		const aPath = parts[2]
		const bPath = parts[3]
		const oldPath = normalizePathFromDiff(aPath)
		const path = normalizePathFromDiff(bPath)

		currentFile = {
			path,
			oldPath: oldPath !== path ? oldPath : undefined,
			changeType: "modify",
			isBinary: false,
			hunkIds: []
		}
	}

	async function handleLine(line: string): Promise<void> {
		if (isFileHeader(line)) {
			await flushFile()
			beginFileFromHeader(line)
			return
		}

		if (!currentFile) {
			return
		}

		// Detect binary patches early.
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			currentFile.isBinary = true
			return
		}

		if (line.startsWith("new file mode ")) {
			currentFile.changeType = "add"
			return
		}

		if (line.startsWith("deleted file mode ")) {
			currentFile.changeType = "delete"
			return
		}

		if (line.startsWith("rename from ")) {
			currentFile.changeType = "rename"
			currentFile.oldPath = line.slice("rename from ".length).trim()
			return
		}

		if (line.startsWith("rename to ")) {
			currentFile.changeType = "rename"
			currentFile.path = line.slice("rename to ".length).trim()
			return
		}

		if (line.startsWith("copy from ")) {
			currentFile.changeType = "copy"
			currentFile.oldPath = line.slice("copy from ".length).trim()
			return
		}

		if (line.startsWith("copy to ")) {
			currentFile.changeType = "copy"
			currentFile.path = line.slice("copy to ".length).trim()
			return
		}

		if (isHunkHeader(line)) {
			await flushHunk()
			currentHunkHeader = line
			currentHunkLines = []
			currentHunkBytes = Buffer.byteLength(line, "utf8") + 1
			currentHunkTruncated = false
			return
		}

		if (currentHunkLines) {
			if (currentHunkTruncated) return

			const lineBytes = Buffer.byteLength(line, "utf8") + 1
			if (currentHunkBytes + lineBytes > limits.maxHunkBytes) {
				// Truncate deterministically and stop accumulating further lines for this hunk.
				const remaining = limits.maxHunkBytes - currentHunkBytes
				if (remaining > 1) {
					const slice = line.slice(0, Math.max(0, remaining - 1))
					if (slice) currentHunkLines.push(slice)
				}
				currentHunkLines.push("\\ No newline at end of truncated hunk (ai-publish)")
				currentHunkBytes = limits.maxHunkBytes
				currentHunkTruncated = true
				return
			}
			currentHunkLines.push(line)
			currentHunkBytes += lineBytes
		}
	}

	// Stream stdout by lines.
	let buffered = ""
	for await (const chunk of child.stdout) {
		buffered += chunk
		while (true) {
			const idx = buffered.indexOf("\n")
			if (idx === -1) break
			const line = buffered.slice(0, idx).replace(/\r$/, "")
			buffered = buffered.slice(idx + 1)
			await handleLine(line)
		}
	}

	if (buffered.length > 0) {
		await handleLine(buffered.replace(/\r$/, ""))
	}

	const exitCode: number = await closePromise
	if (exitCode !== 0) {
		throw new Error(`git diff failed (exit ${exitCode})${stderr.trim() ? `\n${stderr.trim()}` : ""}`)
	}

	await flushFile()

	// Deterministic ordering.
	files.sort((a, b) => compareStrings(a.path, b.path))

	manifest.files = files.map((f) => ({
		path: f.path,
		oldPath: f.oldPath,
		changeType: f.changeType,
		isBinary: f.isBinary,
		hunkIds: f.hunkIds
	}))

	totalHunks = manifest.files.reduce((n, f) => n + f.hunkIds.length, 0)

	return { manifest, hunkDir, totalHunks }
}
