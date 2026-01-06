import type { ChangelogModel } from "./types"

export function validateChangelogModel(model: ChangelogModel): { ok: true } | { ok: false; errors: string[] } {
	const errors: string[] = []

	function checkBullets(section: string, bullets: Array<{ text: string; evidenceNodeIds: string[] }>) {
		for (const b of bullets) {
			if (!b.evidenceNodeIds || b.evidenceNodeIds.length === 0) {
				errors.push(`${section}: bullet has no evidence: '${b.text}'`)
				continue
			}
			for (const id of b.evidenceNodeIds) {
				if (!model.evidence[id]) errors.push(`${section}: unknown evidence node '${id}' for bullet '${b.text}'`)
			}
		}
	}

	checkBullets("Breaking Changes", model.breakingChanges)
	checkBullets("Added", model.added)
	checkBullets("Changed", model.changed)
	checkBullets("Fixed", model.fixed)
	checkBullets("Removed", model.removed)
	checkBullets("Internal / Tooling", model.internalTooling)

	return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
