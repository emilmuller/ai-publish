function normalizeNewlines(s: string): string {
	return (s ?? "").replace(/\r\n/g, "\n")
}

function ensureTrailingNewline(s: string): string {
	return s.endsWith("\n") ? s : s + "\n"
}

function trimBlankLinesEnd(s: string): string {
	return s.replace(/\n+$/g, "\n").replace(/\n$/g, "")
}

function trimBlankLinesStart(s: string): string {
	return s.replace(/^(?:\s*\n)+/g, "")
}

function firstNonEmptyLineIndex(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? "").trim().length > 0) return i
	}
	return -1
}

export function migrateLegacyChangelogIfNeeded(markdown: string): string {
	const s = normalizeNewlines(markdown)
	const lines = s.split("\n")
	const firstIdx = firstNonEmptyLineIndex(lines)
	if (firstIdx < 0) return ""
	const first = (lines[firstIdx] ?? "").trim()

	const m = /^#\s+Changelog\s*\(([^)]+)\)\s*$/.exec(first)
	if (!m) return ensureTrailingNewline(s)

	const range = m[1] ?? ""
	const parts = range.split("..")
	const headRaw = (parts[1] ?? "").trim()
	const versionLabel = headRaw
		? headRaw.replace(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i, "$1")
		: "Unreleased"

	const rest = lines
		.slice(firstIdx + 1)
		.join("\n")
		.trim()
	const body = rest ? rest : ""

	const out = ["# Changelog", "", "## [" + versionLabel + "]", body ? "" : "", body]
		.filter((x) => x !== undefined)
		.join("\n")

	return ensureTrailingNewline(out.trimEnd() + "\n")
}

export function extractFirstKeepAChangelogEntry(markdown: string): { entryMarkdown: string; versionLabel: string } {
	const s = normalizeNewlines(markdown)
	const lines = s.split("\n")

	let start = -1
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+\[[^\]]+\]/.test((lines[i] ?? "").trim())) {
			start = i
			break
		}
	}
	if (start < 0) throw new Error("Could not find a Keep a Changelog version heading (## [x])")

	const header = (lines[start] ?? "").trim()
	const m = /^##\s+\[([^\]]+)\]/.exec(header)
	const versionLabel = (m?.[1] ?? "").trim()
	if (!versionLabel) throw new Error("Could not parse version label from Keep a Changelog heading")

	let endExclusive = lines.length
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+\[[^\]]+\]/.test((lines[i] ?? "").trim())) {
			endExclusive = i
			break
		}
	}

	const entry = lines.slice(start, endExclusive).join("\n")
	return { entryMarkdown: ensureTrailingNewline(entry.trimEnd() + "\n"), versionLabel }
}

export function upsertKeepAChangelogEntry(params: {
	existingMarkdown: string
	newEntryMarkdown: string
	/**
	 * If true, when the version already exists we will replace it.
	 * By default, only the special version label "Unreleased" is replaced.
	 */
	replaceExisting?: boolean
}): string {
	const existingNormalized = migrateLegacyChangelogIfNeeded(params.existingMarkdown)
	const existing = normalizeNewlines(existingNormalized)
	const entry = normalizeNewlines(params.newEntryMarkdown).trimEnd()
	if (!entry) return ensureTrailingNewline(existing)

	const entryHeader = entry.split("\n")[0]?.trim() ?? ""
	const m = /^##\s+\[([^\]]+)\]/.exec(entryHeader)
	const versionLabel = (m?.[1] ?? "").trim()
	if (!versionLabel) throw new Error("Could not parse version label from Keep a Changelog heading")

	const shouldReplace = params.replaceExisting === true || versionLabel === "Unreleased"
	const escapedLabel = versionLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const headerRe = new RegExp(`^##\\s+\\[${escapedLabel}\\]`, "m")

	if (!headerRe.test(existing)) {
		return prependKeepAChangelogEntry({ existingMarkdown: existing, newEntryMarkdown: entry })
	}
	if (!shouldReplace) {
		throw new Error(`Changelog already contains an entry for version: ${versionLabel}`)
	}

	const lines = existing.split("\n")
	let start = -1
	for (let i = 0; i < lines.length; i++) {
		if (new RegExp(`^##\\s+\\[${escapedLabel}\\]`).test((lines[i] ?? "").trim())) {
			start = i
			break
		}
	}
	if (start < 0) {
		// Header regex matched, but we failed to locate the exact line. Fall back to a prepend.
		return prependKeepAChangelogEntry({ existingMarkdown: existing, newEntryMarkdown: entry })
	}

	let endExclusive = lines.length
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+\[[^\]]+\]/.test((lines[i] ?? "").trim())) {
			endExclusive = i
			break
		}
	}

	const before = trimBlankLinesEnd(lines.slice(0, start).join("\n"))
	const after = trimBlankLinesStart(lines.slice(endExclusive).join("\n"))
	const out = [before, "", entry.trimEnd(), "", after].filter((p) => (p ?? "").trim().length > 0).join("\n")
	return ensureTrailingNewline(out.trimEnd() + "\n")
}

export function prependKeepAChangelogEntry(params: { existingMarkdown: string; newEntryMarkdown: string }): string {
	const existingNormalized = migrateLegacyChangelogIfNeeded(params.existingMarkdown)
	const existing = normalizeNewlines(existingNormalized)
	const entry = normalizeNewlines(params.newEntryMarkdown).trimEnd()
	if (!entry) return ensureTrailingNewline(existing)

	const entryHeader = entry.split("\n")[0]?.trim() ?? ""
	const m = /^##\s+\[([^\]]+)\]/.exec(entryHeader)
	const versionLabel = (m?.[1] ?? "").trim()
	if (versionLabel) {
		const re = new RegExp(`^##\\s+\\[${versionLabel.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]`, "m")
		if (re.test(existing)) {
			throw new Error(`Changelog already contains an entry for version: ${versionLabel}`)
		}
	}

	const lines = existing.split("\n")
	const firstIdx = firstNonEmptyLineIndex(lines)
	if (firstIdx < 0) {
		return ensureTrailingNewline(trimBlankLinesEnd(entry) + "\n")
	}

	// Normalize the top header if present.
	if (/^#\s+Changelog\b/.test((lines[firstIdx] ?? "").trim())) {
		lines[firstIdx] = "# Changelog"
	}

	let insertAt = -1
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+\[[^\]]+\]/.test((lines[i] ?? "").trim())) {
			insertAt = i
			break
		}
	}
	if (insertAt < 0) insertAt = lines.length

	const before = trimBlankLinesEnd(lines.slice(0, insertAt).join("\n"))
	const after = trimBlankLinesStart(lines.slice(insertAt).join("\n"))

	const out = [before, "", entry.trimEnd(), "", after].filter((p) => (p ?? "").trim().length > 0).join("\n")
	return ensureTrailingNewline(out.trimEnd() + "\n")
}
