import { describe, expect, test } from "vitest"
import {
	extractFirstKeepAChangelogEntry,
	migrateLegacyChangelogIfNeeded,
	prependKeepAChangelogEntry,
	upsertKeepAChangelogEntry
} from "../src/changelog/prepend"

describe("changelog prepend helpers", () => {
	test("extracts the first version entry from generated Keep a Changelog markdown", () => {
		const generated = [
			"# Changelog",
			"",
			"Some boilerplate.",
			"",
			"## [Unreleased] - 2026-01-07",
			"### Added",
			"- A",
			"",
			"## [0.1.0] - 2025-12-31",
			"### Fixed",
			"- B",
			""
		].join("\n")

		const { entryMarkdown, versionLabel } = extractFirstKeepAChangelogEntry(generated)
		expect(versionLabel).toBe("Unreleased")
		expect(entryMarkdown).toContain("## [Unreleased] - 2026-01-07")
		expect(entryMarkdown).toContain("### Added")
		expect(entryMarkdown).not.toContain("## [0.1.0]")
	})

	test("migrates legacy range header into a version section", () => {
		const legacy = ["# Changelog (4b825dc642cb6eb9a060e54bf8d69288fbee4904..v0.1.0)", "", "- A", "- B", ""].join(
			"\n"
		)

		const migrated = migrateLegacyChangelogIfNeeded(legacy)
		expect(migrated).toContain("# Changelog")
		expect(migrated).toContain("## [0.1.0]")
		expect(migrated).toContain("- A")
	})

	test("prepends a new entry ahead of existing history", () => {
		const existing = ["# Changelog", "", "## [0.1.0]", "- Initial", ""].join("\n")

		const entry = ["## [0.1.1] - 2026-01-07", "### Fixed", "- Bug", ""].join("\n")
		const out = prependKeepAChangelogEntry({ existingMarkdown: existing, newEntryMarkdown: entry })

		const idxNew = out.indexOf("## [0.1.1]")
		const idxOld = out.indexOf("## [0.1.0]")
		expect(idxNew).toBeGreaterThanOrEqual(0)
		expect(idxOld).toBeGreaterThanOrEqual(0)
		expect(idxNew).toBeLessThan(idxOld)
	})

	test("upserts Unreleased by replacing the existing section", () => {
		const existing = [
			"# Changelog",
			"",
			"Some boilerplate.",
			"",
			"## [Unreleased] - 2026-01-06",
			"### Added",
			"- Old",
			"",
			"## [0.1.0] - 2025-12-31",
			"- Initial",
			""
		].join("\n")

		const entry = ["## [Unreleased] - 2026-01-07", "### Added", "- New", ""].join("\n")
		const out = upsertKeepAChangelogEntry({ existingMarkdown: existing, newEntryMarkdown: entry })

		expect(out).toContain("## [Unreleased] - 2026-01-07")
		expect(out).toContain("- New")
		expect(out).not.toContain("- Old")
		// History stays below.
		expect(out).toContain("## [0.1.0] - 2025-12-31")
	})
})
