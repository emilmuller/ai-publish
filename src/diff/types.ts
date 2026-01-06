export type DiffChangeType = "add" | "modify" | "delete" | "rename" | "copy"

export type Surface = "public-api" | "config" | "cli" | "infra" | "internal" | "tests" | "docs"

export type DiffFileSummary = {
	path: string
	oldPath?: string
	changeType: DiffChangeType
	isBinary: boolean
}

export type DiffSummary = {
	baseSha: string
	headSha: string
	files: DiffFileSummary[]
	totalHunks: number
}

export type DiffHunk = {
	id: string
	filePath: string
	oldPath?: string
	header: string
	lines: string[]
	isTruncated: boolean
	byteLength: number
}

export type DiffIndexManifest = {
	schemaVersion: 1
	baseSha: string
	headSha: string
	files: Array<{
		path: string
		oldPath?: string
		changeType: DiffChangeType
		isBinary: boolean
		hunkIds: string[]
	}>
}

export type IndexDiffResult = {
	baseSha: string
	headSha: string
	indexDir: string
	/** In-memory manifest (also written to `manifestPath` for audit/debug). */
	manifest: DiffIndexManifest
	manifestPath: string
	summary: DiffSummary
}
