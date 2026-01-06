import { spawn } from "node:child_process"
import type { RepoFileMetaRequest, RepoFileMetaResult } from "./types"

function assertValidPath(path: string): string {
	const p = path.replace(/\\/g, "/").trim()
	if (!p) throw new Error("Invalid path: empty")
	if (p.includes("\0")) throw new Error("Invalid path")
	if (p.startsWith("/") || p.startsWith("../") || p.includes("/../") || p === "..") {
		throw new Error(`Invalid path: ${path}`)
	}
	if (p.startsWith("-")) throw new Error(`Invalid path: ${path}`)
	return p
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		let out = ""
		let err = ""
		child.stdout.on("data", (c: string) => (out += c))
		child.stderr.on("data", (c: string) => (err += c))
		child.on("error", reject)
		child.on("close", (code: number | null) => {
			const exit = code ?? 0
			if (exit !== 0) {
				const suffix = err.trim() ? `\n${err.trim()}` : ""
				return reject(new Error(`git ${args[0]} failed (exit ${exit})${suffix}`))
			}
			resolve(out)
		})
	})
}

async function resolveBlobOid(params: { cwd: string; ref: string; path: string }): Promise<string> {
	const { cwd, ref, path } = params
	const out = (await gitStdout(cwd, ["ls-tree", ref, "--", path])).trim()
	// Expected: <mode> <type> <oid>\t<path>
	const m = /^\d+\s+\w+\s+([0-9a-f]{40})\t/.exec(out)
	if (!m) throw new Error(`Path not found at ref ${ref}: ${path}`)
	return m[1]!
}

async function blobSize(params: { cwd: string; oid: string }): Promise<number> {
	const out = (await gitStdout(params.cwd, ["cat-file", "-s", params.oid])).trim()
	const n = Number(out)
	if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid blob size for oid ${params.oid}`)
	return Math.trunc(n)
}

async function probeBinaryAndMaybeCountLines(params: {
	cwd: string
	oid: string
	byteSize: number
	maxLineCountBytes: number
	maxProbeBytes: number
}): Promise<{ isBinary: boolean; lineCount: number | null; lineCountIsTruncated: boolean }> {
	const { cwd, oid, byteSize, maxLineCountBytes, maxProbeBytes } = params

	if (byteSize === 0) {
		return { isBinary: false, lineCount: 0, lineCountIsTruncated: false }
	}

	const shouldCountLines = byteSize <= maxLineCountBytes
	const maxBytes = shouldCountLines ? byteSize : maxProbeBytes

	return await new Promise((resolve, reject) => {
		const child = spawn("git", ["cat-file", "-p", oid], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true
		})

		let stderr = ""
		const maxStderrBytes = 64 * 1024

		let bytesRead = 0
		let isBinary = false
		let lineCount = 0
		let sawAnyByte = false
		let lastByte: number | null = null
		let lineCountIsTruncated = false

		child.stdout.on("data", (chunk: Buffer) => {
			if (bytesRead >= maxBytes) return
			let buf = chunk
			if (bytesRead + buf.length > maxBytes) {
				buf = buf.subarray(0, maxBytes - bytesRead)
				lineCountIsTruncated = true
			}

			bytesRead += buf.length
			sawAnyByte = sawAnyByte || buf.length > 0
			if (buf.length > 0) lastByte = buf[buf.length - 1]!

			if (!isBinary) {
				for (let i = 0; i < buf.length; i++) {
					const b = buf[i]!
					if (b === 0) {
						isBinary = true
						break
					}
					if (shouldCountLines && b === 10) lineCount += 1
				}
			}

			if (bytesRead >= maxBytes) {
				try {
					child.kill()
				} catch {
					// ignore
				}
			}
		})

		child.stderr.on("data", (chunk: string | Buffer) => {
			const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
			if (stderr.length < maxStderrBytes) stderr += s.slice(0, maxStderrBytes - stderr.length)
		})

		child.on("error", reject)

		child.on("close", (code: number | null) => {
			const exitCode = code ?? 0
			// If we killed it early for probing, allow non-zero.
			if (exitCode !== 0 && bytesRead < maxBytes) {
				const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
				return reject(new Error(`git cat-file -p failed (exit ${exitCode})${suffix}`))
			}

			if (isBinary) {
				return resolve({ isBinary: true, lineCount: null, lineCountIsTruncated: true })
			}

			if (!shouldCountLines) {
				return resolve({ isBinary: false, lineCount: null, lineCountIsTruncated: true })
			}

			// Convert newline count to line count.
			// If file doesn't end with newline, add one extra line.
			if (sawAnyByte && lastByte !== 10) lineCount += 1
			resolve({ isBinary: false, lineCount, lineCountIsTruncated: lineCountIsTruncated })
		})
	})
}

export async function getRepoFileMeta(params: {
	cwd: string
	ref: string
	requests: RepoFileMetaRequest[]
	maxTotalBytes: number
	maxFilesPerRequest: number
	maxProbeBytesPerFile: number
	maxLineCountBytesPerFile: number
}): Promise<RepoFileMetaResult[]> {
	const { cwd, ref, maxTotalBytes, maxFilesPerRequest, maxProbeBytesPerFile, maxLineCountBytesPerFile } = params

	let totalBytes = 0
	const results: RepoFileMetaResult[] = []

	const limitedRequests = params.requests.slice(0, clampInt(params.requests.length, 0, maxFilesPerRequest))

	for (const req of limitedRequests) {
		const path = assertValidPath(req.path)
		const oid = await resolveBlobOid({ cwd, ref, path })
		const byteSize = await blobSize({ cwd, oid })

		const probed = await probeBinaryAndMaybeCountLines({
			cwd,
			oid,
			byteSize,
			maxLineCountBytes: maxLineCountBytesPerFile,
			maxProbeBytes: maxProbeBytesPerFile
		})

		const out: RepoFileMetaResult = {
			path,
			ref,
			byteSize,
			isBinary: probed.isBinary,
			lineCount: probed.lineCount,
			lineCountIsTruncated: probed.lineCountIsTruncated,
			byteLength: 0
		}
		out.byteLength = Buffer.byteLength(JSON.stringify(out), "utf8")

		totalBytes += out.byteLength
		if (totalBytes > maxTotalBytes)
			throw new Error(`Requested repo file meta exceeds maxTotalBytes (${maxTotalBytes}).`)

		results.push(out)
	}

	return results
}
