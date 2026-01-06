import type { ChangelogModel } from "./types"

function normalizeOneLine(s: string): string {
	return (s ?? "").trim().replace(/\s+/g, " ")
}

export function buildReleaseTagMessage(params: {
	tag: string
	bumpType: "major" | "minor" | "patch" | "none"
	model: ChangelogModel
	maxBullets?: number
	maxChars?: number
}): string {
	const maxBullets = params.maxBullets ?? 6
	const maxChars = params.maxChars ?? 800

	type Section = { label: string; bullets: Array<{ text: string }> }
	const sections: Section[] = [
		{ label: "Breaking", bullets: params.model.breakingChanges },
		{ label: "Added", bullets: params.model.added },
		{ label: "Changed", bullets: params.model.changed },
		{ label: "Fixed", bullets: params.model.fixed },
		{ label: "Removed", bullets: params.model.removed },
		{ label: "Internal", bullets: params.model.internalTooling }
	]

	const lines: string[] = [`Release ${params.tag}`, `Type: ${params.bumpType}`]

	let usedBullets = 0
	for (const section of sections) {
		for (const b of section.bullets) {
			if (usedBullets >= maxBullets) break
			const t = normalizeOneLine((b as any).text)
			if (!t) continue
			lines.push(`- [${section.label}] ${t}`)
			usedBullets += 1
		}
		if (usedBullets >= maxBullets) break
	}

	let msg = lines.join("\n").trim() + "\n"
	if (msg.length > maxChars) {
		msg = msg.slice(0, Math.max(0, maxChars - 2)).trimEnd() + "…\n"
	}
	return msg
}
