import { describe, expect, test } from "vitest"
import { renderReleaseNotesMarkdown } from "../src/releaseNotes/renderReleaseNotes"

describe("release notes determinism", () => {
	test("sections are emitted in a canonical order", () => {
		const bodyA = [
			"This release improves stability.",
			"",
			"### Fixes",
			"- Fixed z.",
			"- Fixed a.",
			"",
			"### Highlights",
			"- Added b.",
			"- Added a.",
			"",
			"### Security",
			"- Hardened c.",
			"",
			"### Performance",
			"- Faster d.",
			"",
			"### Random Section",
			"- Should be dropped.",
			""
		].join("\n")

		const bodyB = [
			"This release improves stability.",
			"",
			"### Performance",
			"- Faster d.",
			"",
			"### Security",
			"- Hardened c.",
			"",
			"### Highlights",
			"- Added a.",
			"- Added b.",
			"",
			"### Fixes",
			"- Fixed a.",
			"- Fixed z.",
			""
		].join("\n")

		const a = renderReleaseNotesMarkdown({ versionLabel: "v0.0.1", bodyMarkdown: bodyA })
		const b = renderReleaseNotesMarkdown({ versionLabel: "v0.0.1", bodyMarkdown: bodyB })

		expect(a.markdown).toBe(b.markdown)
		// Sanity: canonical section order begins with Highlights when present.
		expect(a.markdown).toContain("### Highlights")
	})
})
