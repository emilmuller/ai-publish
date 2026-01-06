import { spawn } from "node:child_process"
import type { RepoFileSearchRequest, RepoFileSearchResult, RepoFileSearchMatch } from "./types"

function assertValidPath(path: string): void {
	const p = path.replace(/\\/g, "/").trim()
	if (!p) throw new Error("Invalid path: empty")
	if (p.includes("\0")) throw new Error("Invalid path")
	if (p.startsWith("/") || p.startsWith("../") || p.includes("/../") || p === "..") {
		throw new Error(`Invalid path: ${path}`)
	}
	if (p.startsWith("-")) throw new Error(`Invalid path: ${path}`)
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

function normalizeQuery(q: string): string {
	const t = (q ?? "").toString().trim()
	if (!t) throw new Error("Invalid query: empty")
	if (t.length > 200) throw new Error("Invalid query: too long")
	return t
}

function includesWithCase(line: string, query: string, ignoreCase: boolean): boolean {
	if (!ignoreCase) return line.includes(query)
	return line.toLowerCase().includes(query.toLowerCase())
}

export async function searchRepoFiles(params: {
	cwd: string
	ref: string
	requests: RepoFileSearchRequest[]
	maxTotalBytes: number
	maxResultBytes: number
	maxMatchesPerRequest: number
}): Promise<RepoFileSearchResult[]> {
	const { cwd, ref, maxTotalBytes, maxResultBytes, maxMatchesPerRequest } = params

	let totalBytes = 0
	const results: RepoFileSearchResult[] = []

	for (const req of params.requests) {
		assertValidPath(req.path)
		const query = normalizeQuery(req.query)
		const ignoreCase = Boolean(req.ignoreCase)
		const maxMatches = clampInt(req.maxResults ?? maxMatchesPerRequest, 1, maxMatchesPerRequest)

		const out = await streamGitShowSearch({
			cwd,
			ref,
			path: req.path,
			query,
			ignoreCase,
			maxBytes: maxResultBytes,
			maxMatches
		})

		totalBytes += out.byteLength
		if (totalBytes > maxTotalBytes) {
			throw new Error(`Requested repo searches exceed maxTotalBytes (${maxTotalBytes}).`)
		}

		results.push(out)
	}

	return results
}

async function streamGitShowSearch(params: {
	cwd: string
	ref: string
	path: string
	query: string
	ignoreCase: boolean
	maxBytes: number
	maxMatches: number
}): Promise<RepoFileSearchResult> {
	const { cwd, ref, path, query, ignoreCase, maxBytes, maxMatches } = params

	return await new Promise((resolve, reject) => {
		const child = spawn("git", ["show", `${ref}:${path}`], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true
		})

		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")

		let stderr = ""
		const maxStderrBytes = 64 * 1024

		let buffered = ""
		let lineNo = 0
		const matches: RepoFileSearchMatch[] = []
		let byteLength = 0
		let isTruncated = false

		function maybeMatch(line: string): void {
			lineNo += 1

			// Detect binary-ish output (NUL) early.
			if (line.includes("\u0000")) {
				isTruncated = true
				return
			}

			if (!includesWithCase(line, query, ignoreCase)) return

			const serialized = `${lineNo}:${line}`
			const lineBytes = Buffer.byteLength(serialized, "utf8") + 1
			if (byteLength + lineBytes > maxBytes) {
				isTruncated = true
				return
			}

			matches.push({ lineNumber: lineNo, line })
			byteLength += lineBytes

			if (matches.length >= maxMatches) {
				isTruncated = true
			}
		}

		function finishOk(): void {
			resolve({
				path,
				ref,
				query,
				ignoreCase,
				matches,
				isTruncated,
				byteLength
			})
		}

		child.stdout.on("data", (chunk: string) => {
			if (isTruncated) return
			buffered += chunk
			while (true) {
				const idx = buffered.indexOf("\n")
				if (idx === -1) break
				const raw = buffered.slice(0, idx).replace(/\r$/, "")
				buffered = buffered.slice(idx + 1)
				maybeMatch(raw)
				if (isTruncated) {
					try {
						child.kill()
					} catch {
						// ignore
					}
					return
				}
			}
		})

		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < maxStderrBytes) {
				stderr += chunk.slice(0, maxStderrBytes - stderr.length)
			}
		})

		child.on("error", reject)

		child.on("close", (code: number | null) => {
			if (isTruncated) return finishOk()

			if (buffered.length > 0 && !isTruncated) {
				maybeMatch(buffered.replace(/\r$/, ""))
			}

			const exitCode = code ?? 0
			if (exitCode !== 0) {
				// Be resilient: search is best-effort context. If the requested path doesn't exist
				// at this ref (or isn't a file), return an empty result rather than failing the
				// entire pipeline.
				resolve({
					path,
					ref,
					query,
					ignoreCase,
					matches: [],
					isTruncated: true,
					byteLength: 0
				})
				return
			}
			finishOk()
		})
	})
}
