import type { DiffIndexManifest } from "../diff/types"
import { classifyFile, type ClassifyOverrides } from "../classify/classifyFile"
import type { ResolvedInstructions } from "../instructions/types"
import { getMergedDirectives, normalizeRepoPath, splitList } from "../instructions/directives"
import type { EvidenceNode } from "./types"
import { sha256Hex } from "../util/sha256"

export function buildEvidenceFromManifest(
	manifest: DiffIndexManifest,
	options?: {
		instructionsByPath?: Record<string, ResolvedInstructions>
		defaultClassifyOverrides?: ClassifyOverrides
	}
): Record<string, EvidenceNode> {
	const evidence: Record<string, EvidenceNode> = {}
	const byPath = options?.instructionsByPath
	const defaultOverrides = options?.defaultClassifyOverrides

	function mergeOverrides(
		a: ClassifyOverrides | undefined,
		b: ClassifyOverrides | undefined
	): ClassifyOverrides | undefined {
		if (!a && !b) return undefined
		const out: ClassifyOverrides = {}

		function mergeList(key: keyof ClassifyOverrides) {
			const aa = (a?.[key] ?? []) as string[]
			const bb = (b?.[key] ?? []) as string[]
			const merged: string[] = []
			const seen = new Set<string>()
			for (const v of [...aa, ...bb]) {
				if (seen.has(v)) continue
				seen.add(v)
				merged.push(v)
			}
			if (merged.length) (out as any)[key] = merged
		}

		mergeList("publicPathPrefixes")
		mergeList("publicFilePaths")
		mergeList("internalPathPrefixes")
		return Object.keys(out).length ? out : undefined
	}

	function getOverridesForPath(path: string): ClassifyOverrides | undefined {
		if (!byPath) return undefined
		const key = normalizeRepoPath(path)
		const res = byPath[key]
		if (!res) return undefined
		const d = getMergedDirectives(res)

		const publicPathPrefixes = [
			...splitList(d["ai-publish.publicPathPrefixes"]),
			...splitList(d["ai-publish.publicPaths"])
		].map(normalizeRepoPath)
		const publicFilePaths = [
			...splitList(d["ai-publish.publicFilePaths"]),
			...splitList(d["ai-publish.publicFiles"])
		].map(normalizeRepoPath)
		const internalPathPrefixes = [
			...splitList(d["ai-publish.internalPathPrefixes"]),
			...splitList(d["ai-publish.internalPaths"])
		].map(normalizeRepoPath)

		const overrides: ClassifyOverrides = {}
		if (publicPathPrefixes.length) overrides.publicPathPrefixes = publicPathPrefixes
		if (publicFilePaths.length) overrides.publicFilePaths = publicFilePaths
		if (internalPathPrefixes.length) overrides.internalPathPrefixes = internalPathPrefixes
		return Object.keys(overrides).length ? overrides : undefined
	}

	// Deterministic evidence node IDs: fixed-length hash of stable metadata.
	// This avoids enormous IDs for files with many hunks, while keeping full evidence in the node.
	for (const f of manifest.files) {
		const overrides = mergeOverrides(defaultOverrides, getOverridesForPath(f.path))
		const surface = classifyFile(f.path, overrides)
		const sortedHunkIds = [...f.hunkIds].sort()
		const stableKey = JSON.stringify({
			path: f.path,
			oldPath: f.oldPath ?? null,
			changeType: f.changeType,
			isBinary: f.isBinary,
			hunkIds: sortedHunkIds
		})
		const nodeId = sha256Hex(stableKey)
		evidence[nodeId] = {
			id: nodeId,
			filePath: f.path,
			oldPath: f.oldPath,
			changeType: f.changeType,
			surface,
			hunkIds: sortedHunkIds,
			isBinary: f.isBinary
		}
	}

	return evidence
}
