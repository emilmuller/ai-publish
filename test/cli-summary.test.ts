import { describe, expect, test } from "vitest"
import { applyAutoNamingBumpToCliSummary } from "../src/cli"

describe("CLI JSON summary", () => {
	test("release-notes auto-naming uses baseSource=manifest when no previousTag", async () => {
		const updated = await applyAutoNamingBumpToCliSummary({
			current: {
				baseSource: "tag", // what release-notes historically set even when no tags exist
				previousTag: null
			},
			bumped: { base: "abc123", previousVersion: "5.2.0" },
			resolveCommitSha: async () => "abc123"
		})

		expect(updated.baseUsed).toBe("abc123")
		expect(updated.baseCommit).toBe("abc123")
		expect(updated.baseSource).toBe("manifest")
		expect(updated.baseLabel).toBe("abc123")
		expect(updated.previousVersion).toBe("5.2.0")
	})

	test("release-notes auto-naming preserves tag baseSource when previousTag is present", async () => {
		const updated = await applyAutoNamingBumpToCliSummary({
			current: {
				baseSource: "tag",
				previousTag: "v1.2.3"
			},
			bumped: { base: "def456", previousVersion: "1.2.3" },
			resolveCommitSha: async () => "def456"
		})

		expect(updated.baseSource).toBe("tag")
		expect(updated.baseLabel).toBe("v1.2.3")
	})
})
