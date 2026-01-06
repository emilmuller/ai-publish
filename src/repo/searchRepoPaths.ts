import { spawn } from "node:child_process"
import type { RepoPathSearchRequest, RepoPathSearchResult } from "./types"

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

function includesWithCase(haystack: string, needle: string, ignoreCase: boolean): boolean {
	if (!ignoreCase) return haystack.includes(needle)
	return haystack.toLowerCase().includes(needle.toLowerCase())
}

async function listPaths(params: {
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
			if (stderr.length < maxStderrBytes) stderr += chunk.slice(0, maxStderrBytes - stderr.length)
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

export async function searchRepoPaths(params: {
	cwd: string
	ref: string
	requests: RepoPathSearchRequest[]
	maxTotalBytes: number
	maxFilesPerRequest: number
}): Promise<RepoPathSearchResult[]> {
	const { cwd, ref, maxTotalBytes, maxFilesPerRequest } = params

	let totalBytes = 0
	const results: RepoPathSearchResult[] = []

	for (const req of params.requests) {
		const query = normalizeQuery(req.query)
		const ignoreCase = Boolean(req.ignoreCase)
		const pathPrefix = req.pathPrefix ? assertValidPathPrefix(req.pathPrefix) : undefined
		const fileExtensions = normalizeExtensions(req.fileExtensions)
		const maxFiles = clampInt(req.maxFiles ?? maxFilesPerRequest, 1, maxFilesPerRequest)

		const all = await listPaths({ cwd, ref, pathPrefix, maxFiles })
		const filtered = all.filter((p) => {
			if (fileExtensions?.length && !fileExtensions.some((ext) => p.endsWith(ext))) return false
			return includesWithCase(p, query, ignoreCase)
		})

		const byteLength = filtered.reduce((sum, p) => sum + Buffer.byteLength(p, "utf8") + 1, 0)
		const out: RepoPathSearchResult = {
			ref,
			query,
			ignoreCase,
			...(pathPrefix ? { pathPrefix } : {}),
			...(fileExtensions ? { fileExtensions } : {}),
			paths: filtered,
			isTruncated: all.length >= maxFiles,
			byteLength
		}

		totalBytes += out.byteLength
		if (totalBytes > maxTotalBytes)
			throw new Error(`Requested repo path searches exceed maxTotalBytes (${maxTotalBytes}).`)

		results.push(out)
	}

	return results
}
