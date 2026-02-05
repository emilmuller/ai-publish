import type { DiffIndexManifest } from "../diff/types"
import { classifyFile, type ClassifyOverrides } from "../classify/classifyFile"
import type { EvidenceNode } from "./types"
import { sha256Hex } from "../util/sha256"

export function buildEvidenceFromManifest(
	manifest: DiffIndexManifest,
	options?: {
		defaultClassifyOverrides?: ClassifyOverrides
	}
): Record<string, EvidenceNode> {
	const evidence: Record<string, EvidenceNode> = {}
	const defaultOverrides = options?.defaultClassifyOverrides

	// Deterministic evidence node IDs: fixed-length hash of stable metadata.
	// This avoids enormous IDs for files with many hunks, while keeping full evidence in the node.
	for (const f of manifest.files) {
		const overrides = defaultOverrides
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
