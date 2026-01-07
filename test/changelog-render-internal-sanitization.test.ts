import { describe, expect, test } from "vitest"
import { renderKeepAChangelogMarkdown } from "../src/changelog/renderKeepAChangelog"
import type { ChangelogModel } from "../src/changelog/types"

describe("Keep a Changelog rendering", () => {
	test("replaces internal file-path bullets with a generic user-facing line", () => {
		const nodeId = "e1"
		const model: ChangelogModel = {
			breakingChanges: [],
			added: [],
			changed: [],
			fixed: [],
			removed: [],
			internalTooling: [
				{
					text: "Updated src/pipeline/runPostpublishPipeline.ts.",
					evidenceNodeIds: [nodeId]
				}
			],
			evidence: {
				[nodeId]: {
					id: nodeId,
					filePath: "src/pipeline/runPostpublishPipeline.ts",
					changeType: "modify",
					surface: "internal",
					hunkIds: ["h1"],
					isBinary: false
				}
			}
		}

		const md = renderKeepAChangelogMarkdown({ model, versionLabel: "v1.2.3", releaseDateISO: "2026-01-07" })
		expect(md).toContain("### Changed")
		expect(md).toContain("- Performance and stability improvements.")
		expect(md).not.toMatch(/src\/pipeline\/runPostpublishPipeline\.ts/i)
	})
})
