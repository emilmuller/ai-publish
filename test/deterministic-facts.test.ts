import { describe, expect, test } from "vitest"
import { buildDeterministicMechanicalFacts } from "../src/llm/deterministicFacts"
import type { DiffSummary } from "../src/diff/types"
import type { EvidenceNode } from "../src/changelog/types"

describe("deterministic mechanical facts", () => {
	test("is stable and includes counts", () => {
		const diffSummary: DiffSummary = {
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			totalHunks: 3,
			files: [
				{ path: "src/index.ts", changeType: "modify", isBinary: false },
				{ path: "package.json", changeType: "modify", isBinary: false },
				{ path: "docs/readme.md", changeType: "add", isBinary: false }
			]
		}

		const evidence: Record<string, EvidenceNode> = {
			id2: {
				id: "id2",
				filePath: "package.json",
				changeType: "modify",
				surface: "config",
				hunkIds: ["h2"],
				isBinary: false
			},
			id1: {
				id: "id1",
				filePath: "src/index.ts",
				changeType: "modify",
				surface: "public-api",
				hunkIds: ["h1", "h3"],
				isBinary: false
			}
		}

		const factsA = buildDeterministicMechanicalFacts({ diffSummary, evidence })
		const factsB = buildDeterministicMechanicalFacts({ diffSummary, evidence })
		expect(factsA).toEqual(factsB)
		expect(factsA.join("\n")).toContain("filesChanged: 3")
		expect(factsA.join("\n")).toContain("changeTypes:")
		expect(factsA.join("\n")).toContain("surfaces:")
		expect(factsA.join("\n")).toContain("file: package.json")
		expect(factsA.join("\n")).toContain("file: src/index.ts")
	})
})
