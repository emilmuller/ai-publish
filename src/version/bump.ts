import semver from "semver"
import type { ChangelogModel } from "../changelog/types"

export type BumpType = "major" | "minor" | "patch" | "none"

export function computeBumpTypeFromChangelogModel(model: ChangelogModel): BumpType {
	if (model.breakingChanges.length > 0) return "major"
	if (model.added.length > 0) return "minor"
	if (model.changed.length > 0 || model.fixed.length > 0 || model.removed.length > 0) return "patch"
	// Per spec: internal-only changes => none
	return "none"
}

function prereleaseIdentifier(version: string): string {
	const pre = semver.prerelease(version)
	const first = Array.isArray(pre) ? pre[0] : null
	return typeof first === "string" && first.trim() ? first.trim() : "rc"
}

export function computeNextVersion(params: { previousVersion: string; bumpType: BumpType }): string {
	const prev = semver.valid(params.previousVersion)
	if (!prev) throw new Error(`Invalid previousVersion (not semver): ${params.previousVersion}`)

	if (params.bumpType === "none") return prev

	const isPre = semver.prerelease(prev) !== null
	if (isPre) {
		const id = prereleaseIdentifier(prev)
		switch (params.bumpType) {
			case "major": {
				const v = semver.inc(prev, "premajor", id)
				if (!v) throw new Error(`Failed to compute premajor version from ${prev}`)
				return v
			}
			case "minor": {
				const v = semver.inc(prev, "preminor", id)
				if (!v) throw new Error(`Failed to compute preminor version from ${prev}`)
				return v
			}
			case "patch": {
				// Within prerelease stream: increment prerelease counter on the same base.
				const v = semver.inc(prev, "prerelease", id)
				if (!v) throw new Error(`Failed to compute prerelease version from ${prev}`)
				return v
			}
			default:
				return prev
		}
	}

	switch (params.bumpType) {
		case "major": {
			const v = semver.inc(prev, "major")
			if (!v) throw new Error(`Failed to compute major version from ${prev}`)
			return v
		}
		case "minor": {
			const v = semver.inc(prev, "minor")
			if (!v) throw new Error(`Failed to compute minor version from ${prev}`)
			return v
		}
		case "patch": {
			const v = semver.inc(prev, "patch")
			if (!v) throw new Error(`Failed to compute patch version from ${prev}`)
			return v
		}
		default:
			return prev
	}
}

export function assertVersionIncreases(previousVersion: string, nextVersion: string): void {
	const prev = semver.valid(previousVersion)
	const next = semver.valid(nextVersion)
	if (!prev) throw new Error(`Invalid previousVersion (not semver): ${previousVersion}`)
	if (!next) throw new Error(`Invalid nextVersion (not semver): ${nextVersion}`)
	if (!semver.gt(next, prev)) {
		throw new Error(`nextVersion must be greater than previousVersion (prev=${prev}, next=${next})`)
	}
}
