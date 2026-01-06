import { spawn } from "node:child_process"
import type { RepoFileSnippet, RepoFileSnippetRequest } from "./types"

function assertValidPath(path: string): void {
	const p = path.replace(/\\/g, "/").trim()
	if (!p) throw new Error("Invalid path: empty")
	if (p.includes("\0")) throw new Error("Invalid path")
	// Prevent path traversal or odd git pathspec tricks.
	if (p.startsWith("/") || p.startsWith("../") || p.includes("/../") || p === "..") {
		throw new Error(`Invalid path: ${path}`)
	}
	if (p.startsWith("-")) throw new Error(`Invalid path: ${path}`)
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

export async function getRepoFileSnippets(params: {
	cwd: string
	ref: string
	requests: RepoFileSnippetRequest[]
	maxTotalBytes: number
	maxSnippetBytes: number
	maxSnippetLines: number
}): Promise<RepoFileSnippet[]> {
	const { cwd, ref, maxTotalBytes, maxSnippetBytes, maxSnippetLines } = params

	let totalBytes = 0
	const results: RepoFileSnippet[] = []

	for (const req of params.requests) {
		assertValidPath(req.path)

		const startLine = clampInt(req.startLine, 1, Number.MAX_SAFE_INTEGER)
		const endLine = clampInt(req.endLine, startLine, startLine + maxSnippetLines - 1)

		const out = await streamGitShowRange({
			cwd,
			ref,
			path: req.path,
			startLine,
			endLine,
			maxBytes: maxSnippetBytes
		})

		totalBytes += out.byteLength
		if (totalBytes > maxTotalBytes) {
			throw new Error(`Requested repo snippets exceed maxTotalBytes (${maxTotalBytes}).`)
		}

		results.push(out)
	}

	return results
}

async function streamGitShowRange(params: {
	cwd: string
	ref: string
	path: string
	startLine: number
	endLine: number
	maxBytes: number
}): Promise<RepoFileSnippet> {
	const { cwd, ref, path, startLine, endLine, maxBytes } = params

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
		const lines: string[] = []
		let byteLength = 0
		let isTruncated = false

		function maybePushLine(line: string): void {
			lineNo += 1
			if (lineNo < startLine) return
			if (lineNo > endLine) return

			// Detect binary-ish output (NUL) early.
			if (line.includes("\u0000")) {
				isTruncated = true
				return
			}

			const lineBytes = Buffer.byteLength(line, "utf8") + 1
			if (byteLength + lineBytes > maxBytes) {
				isTruncated = true
				return
			}
			lines.push(line)
			byteLength += lineBytes
		}

		function finishOk(): void {
			resolve({
				path,
				ref,
				startLine,
				endLine,
				lines,
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
				maybePushLine(raw)
				if (lineNo >= endLine || isTruncated) {
					// We have what we need; stop streaming.
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
			// If we killed it early, exit code may be non-zero; treat as success if we already got content.
			if (lineNo >= endLine || isTruncated) return finishOk()

			if (buffered.length > 0 && !isTruncated) {
				maybePushLine(buffered.replace(/\r$/, ""))
			}

			const exitCode = code ?? 0
			if (exitCode !== 0) {
				// Missing paths are expected for "best effort" context lookups.
				// Example: the model may ask for src/index.js even if the repo is TS-only.
				// Treat as an empty snippet rather than failing the whole pipeline.
				const trimmed = stderr.trim()
				if (exitCode === 128 && /fatal: path '.+' does not exist in/.test(trimmed)) {
					return resolve({
						path,
						ref,
						startLine,
						endLine,
						lines: [],
						isTruncated: false,
						byteLength: 0
					})
				}
				const suffix = trimmed ? `\n${trimmed}` : ""
				return reject(new Error(`git show ${ref}:${path} failed (exit ${exitCode})${suffix}`))
			}
			finishOk()
		})
	})
}
