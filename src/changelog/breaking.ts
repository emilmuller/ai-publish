import type { ChangelogBullet, EvidenceNode } from "./types"
import type { DiffHunk } from "../diff/types"
import { getDiffHunks } from "../diff/getDiffHunks"
import { compareStrings } from "../util/compare"

function stableBullet(text: string, evidenceNodeIds: string[]): ChangelogBullet {
	return { text, evidenceNodeIds: [...evidenceNodeIds].sort() }
}

function parseMajor(version: string): number | null {
	// Accepts ^2.3.0, ~2.3.0, 2.3.0, >=2.0.0 etc. Best-effort.
	const m = /(\d+)/.exec(version)
	if (!m) return null
	const n = Number(m[1])
	return Number.isFinite(n) ? n : null
}

function parseJsonKeyValue(line: string): { key: string; value: string } | null {
	// Matches: "foo": "^1.2.3"
	const m = /^[-+]\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?$/.exec(line)
	if (!m) return null
	return { key: m[1]!, value: m[2]! }
}

function parseTomlKeyValue(line: string): { key: string; value: string } | null {
	// Matches: version = "1.2.3" (best-effort, string values only)
	const m = /^[-+]\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*$/.exec(line.trimEnd())
	if (!m) return null
	return { key: m[1]!, value: m[2]! }
}

function detectExportRemovals(hunks: DiffHunk[]): boolean {
	for (const h of hunks) {
		for (const line of h.lines) {
			if (!line.startsWith("-")) continue
			if (line.startsWith("---")) continue
			if (line.includes("export ")) return true
		}
	}
	return false
}

function detectRustPublicRemovals(hunks: DiffHunk[]): boolean {
	for (const h of hunks) {
		for (const line of h.lines) {
			if (!line.startsWith("-")) continue
			if (line.startsWith("---")) continue
			const t = line.slice(1)
			// Best-effort signal: removing a `pub` item from the crate public surface.
			if (/\bpub\s+(use|fn|struct|enum|trait|type|const|mod)\b/.test(t)) return true
		}
	}
	return false
}

function detectMajorBumpFromPackageJsonVersion(hunks: DiffHunk[]): { fromMajor: number; toMajor: number } | null {
	let from: number | null = null
	let to: number | null = null
	for (const h of hunks) {
		for (const raw of h.lines) {
			const kv = parseJsonKeyValue(raw)
			if (!kv) continue
			if (kv.key !== "version") continue
			if (raw.startsWith("-")) from = parseMajor(kv.value)
			if (raw.startsWith("+")) to = parseMajor(kv.value)
		}
	}
	if (from == null || to == null) return null
	if (to > from) return { fromMajor: from, toMajor: to }
	return null
}

function detectMajorBumpFromCargoTomlVersion(hunks: DiffHunk[]): { fromMajor: number; toMajor: number } | null {
	let section: "package" | "other" = "other"
	let from: number | null = null
	let to: number | null = null
	for (const h of hunks) {
		for (const raw of h.lines) {
			const line = raw
			if (line.startsWith(" ") && /^\s*\[package\]\s*$/.test(line.trim())) section = "package"
			if (line.startsWith(" ") && /^\s*\[/.test(line.trim()) && !/^\s*\[package\]\s*$/.test(line.trim())) {
				section = "other"
			}
			if (section !== "package") continue
			const kv = parseTomlKeyValue(line)
			if (!kv) continue
			if (kv.key !== "version") continue
			if (line.trimStart().startsWith("-")) from = parseMajor(kv.value)
			if (line.trimStart().startsWith("+")) to = parseMajor(kv.value)
		}
	}
	if (from == null || to == null) return null
	if (to > from) return { fromMajor: from, toMajor: to }
	return null
}

function detectMajorBumpsFromPackageJsonHunks(
	hunks: DiffHunk[]
): Array<{ name: string; fromMajor: number; toMajor: number }> {
	const bumps: Array<{ name: string; fromMajor: number; toMajor: number }> = []

	for (const h of hunks) {
		let section: "dependencies" | "peerDependencies" | "devDependencies" | "other" = "other"
		const removed = new Map<string, string>()

		for (const raw of h.lines) {
			const line = raw
			if (line.startsWith(" ") && line.includes('"dependencies"')) section = "dependencies"
			if (line.startsWith(" ") && line.includes('"peerDependencies"')) section = "peerDependencies"
			if (line.startsWith(" ") && line.includes('"devDependencies"')) section = "devDependencies"

			const kv = parseJsonKeyValue(line)
			if (!kv) continue

			if (section !== "dependencies" && section !== "peerDependencies") continue

			if (line.startsWith("-")) removed.set(kv.key, kv.value)
			if (line.startsWith("+")) {
				const prev = removed.get(kv.key)
				if (!prev) continue
				const fromMajor = parseMajor(prev)
				const toMajor = parseMajor(kv.value)
				if (fromMajor == null || toMajor == null) continue
				if (toMajor > fromMajor) {
					bumps.push({ name: kv.key, fromMajor, toMajor })
				}
			}
		}
	}

	// Deterministic ordering
	bumps.sort((a, b) => compareStrings(a.name, b.name))
	return bumps
}

export async function detectBreakingChanges(params: {
	base: string
	evidence: Record<string, EvidenceNode>
	cwd?: string
}): Promise<ChangelogBullet[]> {
	const bullets: ChangelogBullet[] = []

	const nodes = Object.values(params.evidence).sort((a, b) => compareStrings(a.filePath, b.filePath))

	// File-level breaking indicators (conservative).
	for (const node of nodes) {
		if (node.surface !== "public-api" && node.surface !== "config") continue

		if (node.changeType === "delete") {
			bullets.push(
				stableBullet(`Potential breaking — unclear: removed ${node.surface} file ${node.filePath}`, [node.id])
			)
			continue
		}

		if (node.changeType === "rename") {
			bullets.push(
				stableBullet(
					`Potential breaking — unclear: renamed ${node.surface} file ${node.oldPath ?? "(unknown)"} to ${
						node.filePath
					}`,
					[node.id]
				)
			)
			continue
		}
	}

	// Content-based checks (still conservative, but evidence-backed).
	const entrypoints = new Set(["src/index.ts", "src/index.js", "src/index.mjs", "src/index.cjs"])
	for (const node of nodes) {
		if (!entrypoints.has(node.filePath)) continue
		if (node.hunkIds.length === 0) continue
		const hunks = await getDiffHunks({
			base: params.base,
			hunkIds: node.hunkIds,
			cwd: params.cwd,
			maxTotalBytes: 256 * 1024
		})
		if (detectExportRemovals(hunks)) {
			bullets.push(stableBullet(`Breaking: removed exports from ${node.filePath}`, [node.id]))
		}
	}

	const rustLibNode = nodes.find((n) => n.filePath === "src/lib.rs")
	if (rustLibNode && rustLibNode.hunkIds.length > 0) {
		const hunks = await getDiffHunks({
			base: params.base,
			hunkIds: rustLibNode.hunkIds,
			cwd: params.cwd,
			maxTotalBytes: 256 * 1024
		})
		if (detectRustPublicRemovals(hunks)) {
			bullets.push(stableBullet("Breaking: removed public items from src/lib.rs", [rustLibNode.id]))
		}
	}

	const pkgNode = nodes.find((n) => n.filePath === "package.json")
	if (pkgNode && pkgNode.hunkIds.length > 0) {
		const hunks = await getDiffHunks({
			base: params.base,
			hunkIds: pkgNode.hunkIds,
			cwd: params.cwd,
			maxTotalBytes: 256 * 1024
		})
		const pkgMajor = detectMajorBumpFromPackageJsonVersion(hunks)
		if (pkgMajor) {
			bullets.push(
				stableBullet(
					`Breaking: bumped package major version from v${pkgMajor.fromMajor} to v${pkgMajor.toMajor}`,
					[pkgNode.id]
				)
			)
		}
		const bumps = detectMajorBumpsFromPackageJsonHunks(hunks)
		for (const b of bumps) {
			bullets.push(
				stableBullet(
					`Potential breaking — unclear: bumped dependency ${b.name} from v${b.fromMajor} to v${b.toMajor}`,
					[pkgNode.id]
				)
			)
		}
	}

	const cargoNode = nodes.find((n) => n.filePath === "Cargo.toml")
	if (cargoNode && cargoNode.hunkIds.length > 0) {
		const hunks = await getDiffHunks({
			base: params.base,
			hunkIds: cargoNode.hunkIds,
			cwd: params.cwd,
			maxTotalBytes: 256 * 1024
		})
		const major = detectMajorBumpFromCargoTomlVersion(hunks)
		if (major) {
			bullets.push(
				stableBullet(
					`Breaking: bumped package major version from v${major.fromMajor} to v${major.toMajor} (Cargo.toml)`,
					[cargoNode.id]
				)
			)
		}
	}

	// Deterministic ordering.
	bullets.sort((a, b) => compareStrings(a.text, b.text))
	return bullets
}
