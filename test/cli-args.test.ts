import { describe, expect, test } from "vitest"
import { parseCliArgs } from "../src/cli"

describe("cli args", () => {
	test("requires --llm", () => {
		expect(() => parseCliArgs(["changelog", "--base", "HEAD"])).toThrow(/--llm/i)
	})

	test("base is optional", () => {
		const parsed = parseCliArgs(["changelog", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "changelog",
			base: undefined,
			outPath: "CHANGELOG.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "azure"
		})
	})

	test("accepts --llm openai", () => {
		const parsed = parseCliArgs(["changelog", "--llm", "openai"])
		expect(parsed).toEqual({
			command: "changelog",
			base: undefined,
			outPath: "CHANGELOG.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "openai"
		})
	})

	test("parses required base and llm", () => {
		const parsed = parseCliArgs(["changelog", "--base", "HEAD", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "changelog",
			base: "HEAD",
			outPath: "CHANGELOG.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "azure"
		})
	})

	test("parses release-notes with defaults", () => {
		const parsed = parseCliArgs(["release-notes", "--base", "HEAD", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "release-notes",
			base: "HEAD",
			previousVersion: undefined,
			outPath: "RELEASE_NOTES.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "azure"
		})
	})

	test("parses prepublish with defaults", () => {
		const parsed = parseCliArgs(["prepublish", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "prepublish",
			base: undefined,
			previousVersion: undefined,
			previousVersionSource: "manifest",
			projectType: "npm",
			manifestPath: undefined,
			writeManifest: true,
			packageJsonPath: "package.json",
			changelogOutPath: "CHANGELOG.md",
			outProvided: false,
			llm: "azure"
		})
	})

	test("parses --previous-version for release-notes", () => {
		const parsed = parseCliArgs(["release-notes", "--previous-version", "1.2.3", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "release-notes",
			base: undefined,
			previousVersion: "1.2.3",
			outPath: "RELEASE_NOTES.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "azure"
		})
	})

	test("parses --base and --previous-version for prepublish", () => {
		const parsed = parseCliArgs(["prepublish", "--base", "HEAD~1", "--previous-version", "9.9.9", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "prepublish",
			base: "HEAD~1",
			previousVersion: "9.9.9",
			previousVersionSource: "manifest",
			projectType: "npm",
			manifestPath: undefined,
			writeManifest: true,
			packageJsonPath: "package.json",
			changelogOutPath: "CHANGELOG.md",
			outProvided: false,
			llm: "azure"
		})
	})

	test("parses --previous-version-from-manifest-history for prepublish", () => {
		const parsed = parseCliArgs(["prepublish", "--previous-version-from-manifest-history", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "prepublish",
			base: undefined,
			previousVersion: undefined,
			previousVersionSource: "manifest-history",
			projectType: "npm",
			manifestPath: undefined,
			writeManifest: true,
			packageJsonPath: "package.json",
			changelogOutPath: "CHANGELOG.md",
			outProvided: false,
			llm: "azure"
		})
	})

	test("parses postpublish", () => {
		const parsed = parseCliArgs(["postpublish"])
		expect(parsed).toEqual({
			command: "postpublish",
			projectType: "npm",
			manifestPath: undefined,
			publishCommand: undefined,
			skipPublish: false,
			llm: undefined
		})
	})

	test("rejects --prepend (removed flag)", () => {
		expect(() => parseCliArgs(["changelog", "--base", "HEAD", "--prepend", "--llm", "azure"])).toThrow(
			/Unknown flag/i
		)
	})

	test("rejects unknown flag", () => {
		expect(() => parseCliArgs(["changelog", "--base", "HEAD", "--wat"])).toThrow(/Unknown flag/i)
	})

	test("rejects unknown LLM provider", () => {
		expect(() => parseCliArgs(["changelog", "--llm", "wat"])).toThrow(/Unsupported LLM provider/i)
	})

	test("help flag produces help", () => {
		const parsed = parseCliArgs(["--help"])
		expect(parsed).toEqual({ command: "help" })
	})

	test("parses commit-context flags", () => {
		const parsed = parseCliArgs([
			"changelog",
			"--llm",
			"azure",
			"--commit-context",
			"snippet",
			"--commit-context-bytes",
			"4096",
			"--commit-context-commits",
			"12"
		])
		expect(parsed).toEqual({
			command: "changelog",
			base: undefined,
			outPath: "CHANGELOG.md",
			outProvided: false,
			commitContext: { mode: "snippet", maxTotalBytes: 4096, maxCommits: 12 },
			llm: "azure"
		})
	})

	test("parses --index-root-dir", () => {
		const parsed = parseCliArgs(["changelog", "--llm", "azure", "--index-root-dir", "C:/tmp/ai-publish"])
		expect(parsed).toEqual({
			command: "changelog",
			base: undefined,
			outPath: "CHANGELOG.md",
			outProvided: false,
			indexRootDir: "C:/tmp/ai-publish",
			commitContext: { mode: "snippet", maxTotalBytes: 65536, maxCommits: 200 },
			llm: "azure"
		})
	})

	test("allows disabling commit context", () => {
		const parsed = parseCliArgs(["changelog", "--llm", "azure", "--commit-context", "none"])
		expect(parsed).toEqual({
			command: "changelog",
			base: undefined,
			outPath: "CHANGELOG.md",
			outProvided: false,
			commitContext: { mode: "none" },
			llm: "azure"
		})
	})

	test("parses surface classification override flags (repeatable)", () => {
		const parsed = parseCliArgs([
			"prepublish",
			"--llm",
			"azure",
			"--public-path-prefix",
			"Veracity.GenAI.AspNetCore",
			"--public-path-prefix",
			"Veracity.GenAI.AspNetCore/Sub",
			"--public-file-path",
			"src/index.ts",
			"--internal-path-prefix",
			"generated",
			"--internal-path-prefix",
			"generated" // duplicates are deduped
		])
		expect(parsed).toEqual({
			command: "prepublish",
			base: undefined,
			previousVersion: undefined,
			previousVersionSource: "manifest",
			projectType: "npm",
			manifestPath: undefined,
			writeManifest: true,
			packageJsonPath: "package.json",
			changelogOutPath: "CHANGELOG.md",
			outProvided: false,
			defaultClassifyOverrides: {
				publicPathPrefixes: ["Veracity.GenAI.AspNetCore", "Veracity.GenAI.AspNetCore/Sub"],
				publicFilePaths: ["src/index.ts"],
				internalPathPrefixes: ["generated"]
			},
			llm: "azure"
		})
	})
})
