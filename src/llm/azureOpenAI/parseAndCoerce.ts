import type { ChangelogBullet, EvidenceNode } from "../../changelog/types"
import type {
	RepoFileSnippetRequest,
	RepoFileSearchRequest,
	RepoTextSearchRequest,
	RepoPathSearchRequest,
	RepoFileListRequest,
	RepoSnippetAroundRequest,
	RepoFileMetaRequest
} from "../../repo/types"
import type { ResolvedInstructions } from "../../instructions/types"

function asRecord(v: unknown): Record<string, unknown> | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null
	return v as Record<string, unknown>
}

function stripCodeFences(text: string): string {
	const t = text.trim()
	const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
	return m ? m[1].trim() : t
}

function extractFirstJsonValue(text: string): string | null {
	// Best-effort recovery for providers that occasionally emit extra text, multiple JSON
	// objects, or truncated output. We scan for the first balanced JSON object/array.
	const s = text.trim()
	let start = -1
	let openChar: "{" | "[" | null = null
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (c === "{" || c === "[") {
			start = i
			openChar = c
			break
		}
	}
	if (start < 0 || !openChar) return null

	const closeChar = openChar === "{" ? "}" : "]"
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < s.length; i++) {
		const c = s[i]
		if (inString) {
			if (escaped) {
				escaped = false
				continue
			}
			if (c === "\\") {
				escaped = true
				continue
			}
			if (c === '"') {
				inString = false
			}
			continue
		}

		if (c === '"') {
			inString = true
			continue
		}

		if (c === openChar) depth++
		else if (c === closeChar) {
			depth--
			if (depth === 0) {
				return s.slice(start, i + 1)
			}
		}
	}

	return null
}

export function parseJsonObject<T>(label: string, text: string): T {
	const raw = stripCodeFences(text)
	try {
		return JSON.parse(raw) as T
	} catch {
		const recovered = extractFirstJsonValue(raw)
		if (recovered) {
			try {
				return JSON.parse(recovered) as T
			} catch {
				// fall through to error
			}
		}
		throw new Error(`${label}: expected JSON but got: ${raw.slice(0, 400)}`)
	}
}

export function assertStringArray(label: string, v: unknown): string[] {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
		throw new Error(`${label}: expected string[]`)
	}
	return v as string[]
}

export function assertString(label: string, v: unknown): string {
	if (typeof v !== "string" || !v.trim()) throw new Error(`${label}: expected non-empty string`)
	return v
}

export function assertBulletArray(label: string, v: unknown): ChangelogBullet[] {
	if (!Array.isArray(v)) throw new Error(`${label}: expected bullet[]`)
	for (const item of v) {
		const obj = asRecord(item)
		if (!obj) throw new Error(`${label}: expected bullet object`)
		if (typeof obj.text !== "string") throw new Error(`${label}: bullet.text must be string`)
		if (!Array.isArray(obj.evidenceNodeIds) || obj.evidenceNodeIds.some((x) => typeof x !== "string")) {
			throw new Error(`${label}: bullet.evidenceNodeIds must be string[]`)
		}
	}
	return v as ChangelogBullet[]
}

export function renderEvidenceIndex(evidence: Record<string, EvidenceNode>): string {
	const ids = Object.keys(evidence).sort()
	const lines: string[] = []
	for (const id of ids) {
		const e = evidence[id]!
		lines.push(
			[
				`id: ${e.id}`,
				`file: ${e.filePath}`,
				e.oldPath ? `oldFile: ${e.oldPath}` : "",
				`type: ${e.changeType}`,
				`surface: ${e.surface}`,
				`binary: ${e.isBinary ? "yes" : "no"}`,
				`hunks: ${e.hunkIds.join(",")}`
			]
				.filter(Boolean)
				.join(" | ")
		)
	}
	return lines.join("\n")
}

export function renderEvidenceIndexRedactedForReleaseNotes(evidence: Record<string, EvidenceNode>): string {
	// Release notes should not encourage leaking internal file paths.
	// Provide IDs + high-signal metadata only; IDs are still required for auditability.
	// For public-facing surfaces, include a minimal, non-sensitive file hint to help the model
	// refer to *public* changes more concretely without exposing internal paths.
	const ids = Object.keys(evidence).sort()
	const lines: string[] = []
	for (const id of ids) {
		const e = evidence[id]!
		const safeFileHint =
			e.surface === "public-api" || e.surface === "config"
				? (e.filePath.replace(/\\/g, "/").split("/").pop() ?? "")
				: ""
		lines.push(
			[
				`id: ${e.id}`,
				safeFileHint ? `fileHint: ${safeFileHint}` : "",
				`type: ${e.changeType}`,
				`surface: ${e.surface}`,
				`binary: ${e.isBinary ? "yes" : "no"}`,
				`hunks: ${e.hunkIds.length}`
			]
				.filter(Boolean)
				.join(" | ")
		)
	}
	return lines.join("\n")
}

export function summarizeInstructions(resolved: ResolvedInstructions[]): string {
	if (!resolved.length) return "(none)"
	const lines: string[] = []
	for (const r of resolved) {
		lines.push(`- target: ${r.targetPath}`)
		for (const w of r.warnings) lines.push(`  - warning: ${w}`)
		for (const f of r.agents) lines.push(`  - agents: ${f.path}`)
		for (const f of r.copilot) lines.push(`  - copilot: ${f.path}`)
	}
	return lines.join("\n")
}

export function coerceStringArray(v: unknown): string[] {
	if (v == null) return []
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
	if (typeof v === "string") {
		const t = v.trim()
		if (!t) return []
		// Allow either a single id or a whitespace/comma-separated list.
		return t
			.split(/[\s,]+/g)
			.map((s) => s.trim())
			.filter(Boolean)
	}
	return []
}

export function coerceSnippetRequests(v: unknown): RepoFileSnippetRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoFileSnippetRequest[] = []
	for (const item of v) {
		const obj = asRecord(item)
		if (!obj) continue
		if (typeof obj.path !== "string") continue
		const startLine = Number(obj.startLine)
		const endLine = Number(obj.endLine)
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue
		out.push({ path: obj.path, startLine: Math.trunc(startLine), endLine: Math.trunc(endLine) })
	}
	return out
}

export function coerceSearchRequests(v: unknown): RepoFileSearchRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoFileSearchRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		if (typeof anyItem.path !== "string") continue
		if (typeof anyItem.query !== "string") continue
		const ignoreCase = typeof anyItem.ignoreCase === "boolean" ? anyItem.ignoreCase : undefined
		const maxResults =
			anyItem.maxResults == null
				? undefined
				: Number.isFinite(Number(anyItem.maxResults))
					? Math.trunc(Number(anyItem.maxResults))
					: undefined
		out.push({
			path: anyItem.path,
			query: anyItem.query,
			...(ignoreCase != null ? { ignoreCase } : {}),
			...(maxResults != null ? { maxResults } : {})
		})
	}
	return out
}

export function coerceRepoSearchRequests(v: unknown): RepoTextSearchRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoTextSearchRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		if (typeof anyItem.query !== "string") continue
		const ignoreCase = typeof anyItem.ignoreCase === "boolean" ? anyItem.ignoreCase : undefined
		const pathPrefix = typeof anyItem.pathPrefix === "string" ? anyItem.pathPrefix : undefined
		const fileExtensions = Array.isArray(anyItem.fileExtensions)
			? anyItem.fileExtensions.filter((s): s is string => typeof s === "string")
			: undefined
		const maxResults =
			anyItem.maxResults == null
				? undefined
				: Number.isFinite(Number(anyItem.maxResults))
					? Math.trunc(Number(anyItem.maxResults))
					: undefined
		const maxFiles =
			anyItem.maxFiles == null
				? undefined
				: Number.isFinite(Number(anyItem.maxFiles))
					? Math.trunc(Number(anyItem.maxFiles))
					: undefined
		out.push({
			query: anyItem.query,
			...(ignoreCase != null ? { ignoreCase } : {}),
			...(pathPrefix != null ? { pathPrefix } : {}),
			...(fileExtensions != null ? { fileExtensions } : {}),
			...(maxResults != null ? { maxResults } : {}),
			...(maxFiles != null ? { maxFiles } : {})
		})
	}
	return out
}

export function coerceRepoFileListRequests(v: unknown): RepoFileListRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoFileListRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		const pathPrefix = typeof anyItem.pathPrefix === "string" ? anyItem.pathPrefix : undefined
		const fileExtensions = Array.isArray(anyItem.fileExtensions)
			? anyItem.fileExtensions.filter((s): s is string => typeof s === "string")
			: undefined
		const maxFiles =
			anyItem.maxFiles == null
				? undefined
				: Number.isFinite(Number(anyItem.maxFiles))
					? Math.trunc(Number(anyItem.maxFiles))
					: undefined
		out.push({
			...(pathPrefix != null ? { pathPrefix } : {}),
			...(fileExtensions != null ? { fileExtensions } : {}),
			...(maxFiles != null ? { maxFiles } : {})
		})
	}
	return out
}

export function coerceRepoPathSearchRequests(v: unknown): RepoPathSearchRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoPathSearchRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		if (typeof anyItem.query !== "string") continue
		const ignoreCase = typeof anyItem.ignoreCase === "boolean" ? anyItem.ignoreCase : undefined
		const pathPrefix = typeof anyItem.pathPrefix === "string" ? anyItem.pathPrefix : undefined
		const fileExtensions = Array.isArray(anyItem.fileExtensions)
			? anyItem.fileExtensions.filter((s): s is string => typeof s === "string")
			: undefined
		const maxFiles =
			anyItem.maxFiles == null
				? undefined
				: Number.isFinite(Number(anyItem.maxFiles))
					? Math.trunc(Number(anyItem.maxFiles))
					: undefined
		out.push({
			query: anyItem.query,
			...(ignoreCase != null ? { ignoreCase } : {}),
			...(pathPrefix != null ? { pathPrefix } : {}),
			...(fileExtensions != null ? { fileExtensions } : {}),
			...(maxFiles != null ? { maxFiles } : {})
		})
	}
	return out
}

export function coerceSnippetAroundRequests(v: unknown): RepoSnippetAroundRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoSnippetAroundRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		if (typeof anyItem.path !== "string") continue
		const lineNumber = Number(anyItem.lineNumber)
		if (!Number.isFinite(lineNumber)) continue
		const contextLines =
			anyItem.contextLines == null
				? undefined
				: Number.isFinite(Number(anyItem.contextLines))
					? Math.trunc(Number(anyItem.contextLines))
					: undefined
		out.push({
			path: anyItem.path,
			lineNumber: Math.trunc(lineNumber),
			...(contextLines != null ? { contextLines } : {})
		})
	}
	return out
}

export function coerceRepoFileMetaRequests(v: unknown): RepoFileMetaRequest[] {
	if (!Array.isArray(v)) return []
	const out: RepoFileMetaRequest[] = []
	for (const item of v) {
		const anyItem = asRecord(item)
		if (!anyItem) continue
		if (typeof anyItem.path !== "string") continue
		out.push({ path: anyItem.path })
	}
	return out
}
