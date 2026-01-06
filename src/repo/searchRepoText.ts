import { spawn } from "node:child_process"
import type { RepoTextSearchMatch, RepoTextSearchRequest, RepoTextSearchResult } from "./types"

function assertValidPathPrefix(pathPrefix: string): string {
	const p = pathPrefix.replace(/\\/g, "/").trim()
	if (!p) throw new Error("Invalid pathPrefix: empty")
	if (p.includes("\0")) throw new Error("Invalid pathPrefix")
	if (p.startsWith("/") || p.startsWith("../") || p.includes("/../") || p === "..") {
		throw new Error(`Invalid pathPrefix: ${pathPrefix}`)
	}
	if (p.startsWith("-")) throw new Error(`Invalid pathPrefix: ${pathPrefix}`)
	return p
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

function normalizeExtensions(exts: unknown): string[] | undefined {
	if (!Array.isArray(exts)) return undefined
	const out: string[] = []
	for (const e of exts) {
		if (typeof e !== "string") continue
		const t = e.trim()
		if (!t) continue
		out.push(t.startsWith(".") ? t : `.${t}`)
	}
	return out.length ? out : undefined
}

function includesWithCase(line: string, query: string, ignoreCase: boolean): boolean {
	if (!ignoreCase) return line.includes(query)
	return line.toLowerCase().includes(query.toLowerCase())
}

async function listRepoFiles(params: {
	cwd: string
	ref: string
	pathPrefix?: string
	maxFiles: number
}): Promise<string[]> {
	const { cwd, ref, maxFiles } = params
	const pathPrefix = params.pathPrefix ? assertValidPathPrefix(params.pathPrefix) : undefined

	return await new Promise((resolve, reject) => {
		const args = ["ls-tree", "-r", "--name-only", ref]
		if (pathPrefix) args.push("--", pathPrefix)

		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")

		let stderr = ""
		const maxStderrBytes = 64 * 1024

		let buffered = ""
		const files: string[] = []

		function pushFile(line: string): void {
			const p = line.replace(/\r$/, "").trim()
			if (!p) return
			files.push(p)
		}

		child.stdout.on("data", (chunk: string) => {
			if (files.length >= maxFiles) return
			buffered += chunk
			while (files.length < maxFiles) {
				const idx = buffered.indexOf("\n")
				if (idx === -1) break
				const line = buffered.slice(0, idx)
				buffered = buffered.slice(idx + 1)
				pushFile(line)
			}
			if (files.length >= maxFiles) {
				try {
					child.kill()
				} catch {
					// ignore
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
			if (buffered.trim() && files.length < maxFiles) pushFile(buffered)
			const exitCode = code ?? 0
			if (exitCode !== 0) {
				const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
				return reject(new Error(`git ls-tree failed (exit ${exitCode})${suffix}`))
			}
			resolve(files)
		})
	})
}

async function searchFile(params: {
	cwd: string
	ref: string
	path: string
	query: string
	ignoreCase: boolean
	maxBytesRemaining: number
	maxMatchesRemaining: number
}): Promise<{ matches: RepoTextSearchMatch[]; usedBytes: number; usedMatches: number; truncated: boolean }> {
	const { cwd, ref, path, query, ignoreCase, maxBytesRemaining, maxMatchesRemaining } = params

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
		const matches: RepoTextSearchMatch[] = []
		let usedBytes = 0
		let usedMatches = 0
		let truncated = false

		function maybeMatch(line: string): void {
			lineNo += 1
			if (truncated) return
			if (line.includes("\u0000")) {
				truncated = true
				return
			}
			if (!includesWithCase(line, query, ignoreCase)) return

			const serialized = `${path}:${lineNo}:${line}`
			const lineBytes = Buffer.byteLength(serialized, "utf8") + 1
			if (usedBytes + lineBytes > maxBytesRemaining) {
				truncated = true
				return
			}
			if (usedMatches + 1 > maxMatchesRemaining) {
				truncated = true
				return
			}

			matches.push({ path, lineNumber: lineNo, line })
			usedBytes += lineBytes
			usedMatches += 1

			if (usedMatches >= maxMatchesRemaining) truncated = true
		}

		child.stdout.on("data", (chunk: string) => {
			if (truncated) return
			buffered += chunk
			while (true) {
				const idx = buffered.indexOf("\n")
				if (idx === -1) break
				const raw = buffered.slice(0, idx).replace(/\r$/, "")
				buffered = buffered.slice(idx + 1)
				maybeMatch(raw)
				if (truncated) {
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
			if (stderr.length < maxStderrBytes) stderr += chunk.slice(0, maxStderrBytes - stderr.length)
		})

		child.on("error", reject)

		child.on("close", (code: number | null) => {
			if (!truncated && buffered.length > 0) maybeMatch(buffered.replace(/\r$/, ""))
			const exitCode = code ?? 0
			if (exitCode !== 0 && !truncated) {
				const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
				return reject(new Error(`git show ${ref}:${path} failed (exit ${exitCode})${suffix}`))
			}
			resolve({ matches, usedBytes, usedMatches, truncated })
		})
	})
}

export async function searchRepoText(params: {
	cwd: string
	ref: string
	requests: RepoTextSearchRequest[]
	maxTotalBytes: number
	maxResultBytes: number
	maxMatchesPerRequest: number
	maxFilesPerRequest: number
}): Promise<RepoTextSearchResult[]> {
	const { cwd, ref, maxTotalBytes, maxResultBytes, maxMatchesPerRequest, maxFilesPerRequest } = params

	let totalBytes = 0
	const results: RepoTextSearchResult[] = []

	for (const req of params.requests) {
		const query = normalizeQuery(req.query)
		const ignoreCase = Boolean(req.ignoreCase)
		const fileExtensions = normalizeExtensions(req.fileExtensions)
		const pathPrefix = req.pathPrefix ? assertValidPathPrefix(req.pathPrefix) : undefined
		const maxFiles = clampInt(req.maxFiles ?? maxFilesPerRequest, 1, maxFilesPerRequest)
		const maxMatches = clampInt(req.maxResults ?? maxMatchesPerRequest, 1, maxMatchesPerRequest)

		const files = await listRepoFiles({ cwd, ref, pathPrefix, maxFiles })

		const matches: RepoTextSearchMatch[] = []
		let byteLength = 0
		let filesScanned = 0
		let isTruncated = false

		for (const filePath of files) {
			filesScanned += 1
			if (fileExtensions?.length) {
				const ok = fileExtensions.some((ext) => filePath.endsWith(ext))
				if (!ok) continue
			}
			if (isTruncated) break

			const remainingBytes = Math.max(0, maxResultBytes - byteLength)
			const remainingMatches = Math.max(0, maxMatches - matches.length)
			if (remainingBytes <= 0 || remainingMatches <= 0) {
				isTruncated = true
				break
			}

			const found = await searchFile({
				cwd,
				ref,
				path: filePath,
				query,
				ignoreCase,
				maxBytesRemaining: remainingBytes,
				maxMatchesRemaining: remainingMatches
			})

			matches.push(...found.matches)
			byteLength += found.usedBytes
			if (found.truncated) {
				isTruncated = true
				break
			}
			if (matches.length >= maxMatches) {
				isTruncated = true
				break
			}
		}

		const out: RepoTextSearchResult = {
			ref,
			query,
			ignoreCase,
			...(pathPrefix ? { pathPrefix } : {}),
			...(fileExtensions ? { fileExtensions } : {}),
			matches,
			filesScanned,
			isTruncated,
			byteLength
		}

		totalBytes += out.byteLength
		if (totalBytes > maxTotalBytes)
			throw new Error(`Requested repo searches exceed maxTotalBytes (${maxTotalBytes}).`)
		results.push(out)
	}

	return results
}
