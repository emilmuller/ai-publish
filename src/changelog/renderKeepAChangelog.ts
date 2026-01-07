import type { ChangelogBullet, ChangelogModel } from "./types"

function normalizeHeadingVersion(label: string): string {
	const v = (label ?? "").trim()
	if (!v) return "Unreleased"
	if (v.toUpperCase() === "HEAD") return "Unreleased"
	if (/^[0-9a-f]{7,40}$/i.test(v)) return "Unreleased"
	// Keep a Changelog examples omit a leading 'v' for semver tags.
	const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(v)
	return m ? m[1]! : v
}

function normalizeOneLine(s: string): string {
	return (s ?? "").trim().replace(/\s+/g, " ")
}

function shouldDropAsInternalFileBullet(text: string): boolean {
	const t = normalizeOneLine(text)
	if (!t) return true

	// Drop bullets that are clearly dev-log style file-path announcements.
	// Allow user-facing artifacts like dist/*, package.json, README.md, etc.
	const looksLikeAnnouncement = /^(added|removed|updated|modified)\s+/i.test(t)
	const containsInternalPath = /\b(src|test|tests|\.github|\.ai-publish)\/[\w./-]+\b/i.test(t)
	const containsSourceExt = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs)\b/i.test(t)
	const mentionsAllowedArtifact =
		/\b(dist|build)\/[\w./-]+\b/i.test(t) || /\b(package\.json|README\.md|CHANGELOG\.md)\b/i.test(t)

	if (mentionsAllowedArtifact) return false
	if (looksLikeAnnouncement && (containsInternalPath || containsSourceExt)) return true
	return false
}

function isInternalSurface(surface: string | undefined): boolean {
	return surface === "internal" || surface === "tests" || surface === "infra"
}

function formatBullets(model: ChangelogModel, bullets: ChangelogBullet[], opts?: { prefix?: string }): string[] {
	const out: string[] = []
	for (const b of bullets) {
		const primaryNodeId = (b.evidenceNodeIds ?? [])[0]
		const primaryNode = primaryNodeId ? model.evidence?.[primaryNodeId] : undefined
		if (primaryNode && isInternalSurface(primaryNode.surface)) {
			// Consumer-facing changelog: omit internal/test/infra-only changes.
			continue
		}

		const text = normalizeOneLine(b.text)
		if (!text) continue
		if (shouldDropAsInternalFileBullet(text)) continue
		out.push(`- ${opts?.prefix ?? ""}${text}`.trimEnd())
	}
	return out
}

export function renderKeepAChangelogMarkdown(params: {
	model: ChangelogModel
	versionLabel?: string
	releaseDateISO?: string
}): string {
	const version = normalizeHeadingVersion(params.versionLabel ?? "")
	const date = (params.releaseDateISO ?? "").trim()

	const breaking = formatBullets(params.model, params.model.breakingChanges, { prefix: "**BREAKING:** " })
	const added = formatBullets(params.model, params.model.added)
	const changed = [...breaking, ...formatBullets(params.model, params.model.changed)]
	const fixed = formatBullets(params.model, params.model.fixed)
	const removed = formatBullets(params.model, params.model.removed)

	const lines: string[] = []
	lines.push("# Changelog")
	lines.push("")
	lines.push("All notable changes to this project will be documented in this file.")
	lines.push("")
	lines.push("The format is based on Keep a Changelog and this project adheres to Semantic Versioning.")
	lines.push("")
	lines.push(`## [${version}]${date ? ` - ${date}` : ""}`)

	function emitSection(title: string, sectionBullets: string[]) {
		if (!sectionBullets.length) return
		lines.push("")
		lines.push(`### ${title}`)
		lines.push(...sectionBullets)
	}

	emitSection("Added", added)
	emitSection("Changed", changed)
	emitSection("Fixed", fixed)
	emitSection("Removed", removed)

	return lines.join("\n").trimEnd() + "\n"
}
