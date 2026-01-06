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
			llm: "azure"
		})
	})

	test("parses release-notes with defaults", () => {
		const parsed = parseCliArgs(["release-notes", "--base", "HEAD", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "release-notes",
			base: "HEAD",
			outPath: "RELEASE_NOTES.md",
			outProvided: false,
			llm: "azure"
		})
	})

	test("parses prepublish with defaults", () => {
		const parsed = parseCliArgs(["prepublish", "--llm", "azure"])
		expect(parsed).toEqual({
			command: "prepublish",
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
		const parsed = parseCliArgs(["postpublish", "--llm", "azure"])
		expect(parsed).toEqual({ command: "postpublish", projectType: "npm", manifestPath: undefined, llm: "azure" })
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
})
