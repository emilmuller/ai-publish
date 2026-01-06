import type { DiffChangeType, Surface } from "../diff/types"

export type EvidenceNode = {
	id: string
	filePath: string
	oldPath?: string
	changeType: DiffChangeType
	surface: Surface
	hunkIds: string[]
	isBinary: boolean
}

export type ChangelogBullet = {
	text: string
	evidenceNodeIds: string[]
}

export type ChangelogModel = {
	breakingChanges: ChangelogBullet[]
	added: ChangelogBullet[]
	changed: ChangelogBullet[]
	fixed: ChangelogBullet[]
	removed: ChangelogBullet[]
	internalTooling: ChangelogBullet[]
	evidence: Record<string, EvidenceNode>
}
