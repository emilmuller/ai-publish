import { runGitOrThrow } from "./runGit"

export type CommitContextMode = "none" | "snippet" | "full"

export type CommitContextCommit = {
	sha: string
	subject: string
	/** Optional bounded snippet of the commit message body (untrusted, context-only). */
	bodySnippet?: string
}

export type CommitContext = {
	baseSha: string
	headSha: string
	commits: CommitContextCommit[]
}

function normalizeCommitText(s: string): string {
	// Commit messages should not contain NULs, but treat input as untrusted.
	return s.replace(/\u0000/g, "").replace(/\r\n/g, "\n")
}

function truncateUtf8(input: string, maxBytes: number, marker: string): { value: string; truncated: boolean } {
	if (maxBytes <= 0) return { value: "", truncated: input.length > 0 }
	const byteLen = Buffer.byteLength(input, "utf8")
	if (byteLen <= maxBytes) return { value: input, truncated: false }

	// Ensure marker fits; if marker itself is too large, drop it.
	const markerBytes = Buffer.byteLength(marker, "utf8")
	const budget = Math.max(0, maxBytes - (markerBytes <= maxBytes ? markerBytes : 0))

	let lo = 0
	let hi = input.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		const slice = input.slice(0, mid)
		if (Buffer.byteLength(slice, "utf8") <= budget) lo = mid
		else hi = mid - 1
	}

	const head = input.slice(0, lo)
	const out = markerBytes <= maxBytes ? head + marker : head
	return { value: out, truncated: true }
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

export async function getCommitContext(params: {
	cwd?: string
	baseSha: string
	headSha: string
	mode?: CommitContextMode
	maxCommits?: number
	maxTotalBytes?: number
	maxSubjectBytes?: number
	maxBodyBytesPerCommit?: number
}): Promise<CommitContext> {
	const cwd = params.cwd ?? process.cwd()
	const mode: CommitContextMode = params.mode ?? "none"

	const maxCommits = clampInt(params.maxCommits ?? 200, 0, 5000)
	const maxTotalBytes = clampInt(params.maxTotalBytes ?? 64 * 1024, 256, 1024 * 1024)
	const maxSubjectBytes = clampInt(params.maxSubjectBytes ?? 256, 16, 4096)
	const maxBodyBytesPerCommit = clampInt(params.maxBodyBytesPerCommit ?? 1024, 0, 64 * 1024)

	if (mode === "none" || maxCommits === 0 || maxTotalBytes <= 2) {
		return { baseSha: params.baseSha, headSha: params.headSha, commits: [] }
	}

	// Machine-parseable output: sha\0subject\0body\0\0 repeated.
	// --topo-order + --reverse provides a stable-ish oldest->newest traversal.
	const range = `${params.baseSha}..${params.headSha}`
	const raw = await runGitOrThrow(
		["log", "--no-color", "--topo-order", "--reverse", "--format=%H%x00%s%x00%b%x00%x00", range],
		{ cwd }
	)

	const recordSep = "\u0000\u0000"
	const records = raw
		.split(recordSep)
		.map((r) => r.trimEnd())
		.filter(Boolean)
	const marker = "… (truncated)"

	const commits: CommitContextCommit[] = []
	let totalBytes = 2 // []

	for (const rec of records) {
		if (commits.length >= maxCommits) break
		const parts = rec.split("\u0000")
		const sha = (parts[0] ?? "").trim()
		if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue

		const subjectRaw = normalizeCommitText(parts[1] ?? "")
		const bodyRaw = normalizeCommitText(parts.slice(2).join("\u0000"))

		const subject = truncateUtf8(subjectRaw, maxSubjectBytes, marker).value
		let bodySnippet: string | undefined
		if (mode === "snippet") {
			const normalizedBody = bodyRaw.trim()
			if (normalizedBody) bodySnippet = truncateUtf8(normalizedBody, maxBodyBytesPerCommit, marker).value
		} else if (mode === "full") {
			// "full" still respects maxBodyBytesPerCommit to preserve hard bounds.
			const normalizedBody = bodyRaw.trim()
			if (normalizedBody) bodySnippet = truncateUtf8(normalizedBody, maxBodyBytesPerCommit, marker).value
		}

		const item: CommitContextCommit = bodySnippet ? { sha, subject, bodySnippet } : { sha, subject }

		const serialized = JSON.stringify(item)
		const itemBytes = Buffer.byteLength(serialized, "utf8")
		const extra = commits.length ? 1 : 0 // comma
		if (totalBytes + extra + itemBytes > maxTotalBytes) break
		commits.push(item)
		totalBytes += extra + itemBytes
	}

	return { baseSha: params.baseSha, headSha: params.headSha, commits }
}
