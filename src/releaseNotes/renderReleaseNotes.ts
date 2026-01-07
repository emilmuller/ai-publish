import { compareStrings } from "../util/compare"

function normalizeOneLine(s: string): string {
	return (s ?? "").trim().replace(/\s+/g, " ")
}

function isBulletLine(line: string): boolean {
	return line.trim().startsWith("- ")
}

function bulletSortKey(line: string): string {
	const t = line.trim()
	const withoutMarker = t.startsWith("- ") ? t.slice(2) : t
	return normalizeOneLine(withoutMarker)
}

function normalizeReleaseVersion(label: string | undefined): string {
	const v = (label ?? "").trim()
	if (!v) return "Unreleased"
	if (v.toUpperCase() === "HEAD") return "Unreleased"
	if (/^[0-9a-f]{7,40}$/i.test(v)) return "Unreleased"

	// Prefer exact published package version format: vX.Y.Z
	if (/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) return v
	if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) return `v${v}`
	return v
}

function shouldDropLine(line: string): boolean {
	const t = normalizeOneLine(line)
	if (!t) return false

	// Explicitly exclude dev-log and internal details.
	const internalPath = /\b(src|test|tests|\.github|\.ai-publish)\/[\w./-]+\b/i.test(t)
	const internalExt = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs)\b/i.test(t)
	const looksLikeFileBullet = /^-\s*(added|removed|updated|modified)\s+/i.test(t)
	const mentionsCommitHash = /\b[0-9a-f]{7,40}\b/i.test(t)
	const mentionsPrOrIssue = /\b(pr|pull request|issue)\s*#?\d+\b/i.test(t)
	const mentionsAllowedArtifact =
		/\b(dist|build)\/[\w./-]+\b/i.test(t) || /\b(package\.json|README\.md|CHANGELOG\.md)\b/i.test(t)

	if (mentionsAllowedArtifact) return false
	if (mentionsPrOrIssue) return true
	if (mentionsCommitHash) return true
	if (looksLikeFileBullet && (internalPath || internalExt)) return true
	if (internalPath) return true
	return false
}

function stripLeadingTopHeadings(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	let i = 0
	while (i < lines.length) {
		const t = (lines[i] ?? "").trim()
		if (!t) {
			i++
			continue
		}
		if (t.startsWith("#")) {
			i++
			continue
		}
		break
	}
	return lines.slice(i).join("\n").trim()
}

const allowedSectionTitles = new Set([
	"Highlights",
	"Breaking Changes",
	"Fixes",
	"Deprecations",
	"Security",
	"Performance"
])

const canonicalSectionOrder = ["Highlights", "Breaking Changes", "Fixes", "Deprecations", "Security", "Performance"]

function canonicalizeSections(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const byTitle = new Map<string, string[]>()
	let currentTitle: string | null = null
	let currentAllowed = true

	for (const line of lines) {
		const t = line.trim()
		const m = /^###\s+(.+)$/.exec(t)
		if (m) {
			const title = m[1]!.trim()
			currentAllowed = allowedSectionTitles.has(title)
			currentTitle = currentAllowed ? title : null
			if (currentTitle && !byTitle.has(currentTitle)) byTitle.set(currentTitle, [])
			continue
		}
		if (!currentAllowed || !currentTitle) continue
		byTitle.get(currentTitle)!.push(line)
	}

	const out: string[] = []
	for (const title of canonicalSectionOrder) {
		const content = byTitle.get(title) ?? []
		const trimmed = content
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
		if (!trimmed) continue
		out.push(`### ${title}`)
		out.push(trimmed)
	}

	return out
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function sortBulletsWithinSections(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const out: string[] = []
	let currentAllowed = true

	let i = 0
	while (i < lines.length) {
		const line = lines[i] ?? ""
		const t = line.trim()
		const m = /^###\s+(.+)$/.exec(t)
		if (m) {
			const title = m[1]!.trim()
			currentAllowed = allowedSectionTitles.has(title)
			if (currentAllowed) out.push(`### ${title}`)
			i++
			continue
		}

		if (!currentAllowed) {
			i++
			continue
		}

		// For allowed sections, sort each contiguous bullet run deterministically.
		if (isBulletLine(line)) {
			const run: string[] = []
			while (i < lines.length && isBulletLine(lines[i] ?? "")) {
				run.push(lines[i] ?? "")
				i++
			}
			run.sort((a, b) => compareStrings(bulletSortKey(a), bulletSortKey(b)) || compareStrings(a, b))
			out.push(...run)
			continue
		}

		out.push(line)
		i++
	}

	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function extractLeadingSummary(body: string): { summary: string; rest: string } {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const summaryLines: string[] = []
	let i = 0
	while (i < lines.length) {
		const raw = lines[i] ?? ""
		const t = raw.trim()
		if (!t) {
			if (summaryLines.length) {
				i++
				break
			}
			i++
			continue
		}
		if (t.startsWith("### ") || t.startsWith("## ") || t.startsWith("# ")) break
		if (t.startsWith("- ")) break
		summaryLines.push(t)
		i++
		// Keep summary short (1–2 sentences). If it grows, stop early.
		if (summaryLines.join(" ").length > 240) break
	}
	const summary = normalizeOneLine(summaryLines.join(" "))
	const rest = lines.slice(i).join("\n").trim()
	return { summary, rest }
}

function sanitizeBody(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const kept: string[] = []
	for (const line of lines) {
		if (shouldDropLine(line)) continue
		kept.push(line)
	}
	// Collapse excessive blank lines.
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function ensureAllowedSections(body: string): string {
	// Keep the public surface the same for callers, but internally emit
	// allowed sections in a canonical, deterministic order.
	return canonicalizeSections(body)
}

function wrapBulletsAsHighlights(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const bullets = lines
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- "))
		.slice(0, 6)
	if (!bullets.length) return ""
	return ["### Highlights", ...bullets].join("\n")
}

export function renderReleaseNotesMarkdown(params: { versionLabel?: string; bodyMarkdown: string }): {
	markdown: string
	bodyMarkdown: string
} {
	const version = normalizeReleaseVersion(params.versionLabel)

	let body = (params.bodyMarkdown ?? "").trim()
	body = stripLeadingTopHeadings(body)
	body = sanitizeBody(body)

	let summary = ""
	if (body) {
		const extracted = extractLeadingSummary(body)
		summary = extracted.summary
		body = extracted.rest
	}

	body = ensureAllowedSections(body)
	body = sortBulletsWithinSections(body)
	if (!body) {
		// If the model returned only bullets (or only filtered content), recover as Highlights.
		const highlights = wrapBulletsAsHighlights(sanitizeBody(stripLeadingTopHeadings(params.bodyMarkdown ?? "")))
		body = highlights
		body = sortBulletsWithinSections(body)
	}

	if (!summary && body) {
		// Neutral default summary if the model didn't provide one.
		summary = "This release includes user-facing improvements and maintenance updates."
	}

	const lines: string[] = [`## ${version}`]
	if (summary) {
		lines.push("")
		lines.push(summary)
	}
	if (body) {
		lines.push("")
		lines.push(body)
	}

	const markdown = lines.join("\n").trimEnd() + "\n"
	const bodyMarkdown = [summary, body].filter(Boolean).join("\n\n").trim()
	return { markdown, bodyMarkdown }
}
