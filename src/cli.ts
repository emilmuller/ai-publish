#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { dirname, join } from "node:path"
import { validateChangelogModel } from "./changelog/validate"
import { runChangelogPipeline } from "./pipeline/runChangelogPipeline"
import { runReleaseNotesPipeline } from "./pipeline/runReleaseNotesPipeline"
import { runVersionBumpPipeline } from "./pipeline/runVersionBumpPipeline"
import { runPrepublishPipeline } from "./pipeline/runPrepublishPipeline"
import { runPostpublishPipeline } from "./pipeline/runPostpublishPipeline"
import { createAzureOpenAILLMClient } from "./llm/azureOpenAI"
import { createOpenAILLMClient } from "./llm/openAI"
import { writeFileAtomic } from "./util/fs"
import { resolveHeadVersionTagFromGitTags, resolveVersionBaseFromGitTags } from "./version/resolveVersionBase"

type ParsedArgs =
	| { command: "help" }
	| {
			command: "changelog"
			base?: string
			outPath: string
			outProvided: boolean
			llm: "azure" | "openai"
	  }
	| {
			command: "release-notes"
			base?: string
			outPath: string
			outProvided: boolean
			llm: "azure" | "openai"
	  }
	| {
			command: "prepublish"
			projectType: "npm" | "dotnet" | "rust" | "python" | "go"
			manifestPath?: string
			writeManifest: boolean
			packageJsonPath?: string
			changelogOutPath: string
			outProvided: boolean
			llm: "azure" | "openai"
	  }
	| {
			command: "postpublish"
			projectType: "npm" | "dotnet" | "rust" | "python" | "go"
			manifestPath?: string
			llm: "azure" | "openai"
	  }

export function formatUsage(): string {
	return [
		"Usage:",
		"  ai-publish changelog [--base <commit>] [--out <path>] --llm <azure|openai>",
		"  ai-publish release-notes [--base <commit>] [--out <path>] --llm <azure|openai>",
		"  ai-publish prepublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--no-write] [--out <path>] --llm <azure|openai>",
		"  ai-publish postpublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] --llm <azure|openai>",
		"  ai-publish --help",
		"",
		"Notes:",
		"  - LLM mode is required; use --llm azure or --llm openai.",
		"  - If --base is omitted, the tool diffs from the previous version tag commit (v<semver>) when present, otherwise from the empty tree.",
		"  - Unknown flags are rejected."
	].join("\n")
}

function usage(exitCode: number): never {
	// eslint-disable-next-line no-console
	console.error(formatUsage())
	process.exit(exitCode)
}

function takeValue(args: string[], i: number, flag: string): string {
	const v = args[i + 1]
	if (!v || v.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`)
	}
	return v
}

export function parseCliArgs(argv: string[]): ParsedArgs {
	const args = [...argv]

	if (args.length === 0) return { command: "help" }
	if (args.includes("--help") || args.includes("-h")) return { command: "help" }

	const command = args[0]
	if (
		command !== "changelog" &&
		command !== "release-notes" &&
		command !== "prepublish" &&
		command !== "postpublish"
	) {
		throw new Error(`Unknown command: ${command}`)
	}

	let base: string | undefined
	let outPath = command === "release-notes" ? "RELEASE_NOTES.md" : "CHANGELOG.md"
	let outProvided = false
	let projectType: "npm" | "dotnet" | "rust" | "python" | "go" = "npm"
	let manifestPath: string | undefined
	let writeManifest = true
	let packageJsonPath: string | undefined = "package.json"
	let llm: "azure" | "openai" | undefined

	const seenFlags = new Set<string>()

	for (let i = 1; i < args.length; i++) {
		const token = args[i]!

		if (!token.startsWith("--")) {
			throw new Error(`Unexpected argument: ${token}`)
		}

		if (seenFlags.has(token)) {
			throw new Error(`Duplicate flag: ${token}`)
		}
		seenFlags.add(token)

		switch (token) {
			case "--base": {
				base = takeValue(args, i, token)
				i += 1
				break
			}
			case "--out": {
				if (command === "postpublish") {
					throw new Error(`--out is not supported for ${command}`)
				}
				outPath = takeValue(args, i, token)
				outProvided = true
				i += 1
				break
			}
			case "--package": {
				if (command !== "prepublish") {
					throw new Error("--package is only supported for prepublish")
				}
				packageJsonPath = takeValue(args, i, token)
				projectType = "npm"
				manifestPath = packageJsonPath
				i += 1
				break
			}
			case "--project-type": {
				if (command !== "prepublish" && command !== "postpublish") {
					throw new Error("--project-type is only supported for prepublish and postpublish")
				}
				const v = takeValue(args, i, token)
				if (v !== "npm" && v !== "dotnet" && v !== "rust" && v !== "python" && v !== "go") {
					throw new Error(`Unsupported project type: ${v}`)
				}
				projectType = v
				i += 1
				break
			}
			case "--manifest": {
				if (command !== "prepublish" && command !== "postpublish") {
					throw new Error("--manifest is only supported for prepublish and postpublish")
				}
				manifestPath = takeValue(args, i, token)
				i += 1
				break
			}
			case "--no-write": {
				if (command !== "prepublish") {
					throw new Error("--no-write is only supported for prepublish")
				}
				writeManifest = false
				break
			}
			case "--llm": {
				const v = takeValue(args, i, token)
				if (v !== "azure" && v !== "openai") throw new Error(`Unsupported LLM provider: ${v}`)
				llm = v
				i += 1
				break
			}
			default:
				throw new Error(`Unknown flag: ${token}`)
		}
	}

	if (!llm) throw new Error("Missing required flag: --llm")

	if (command === "changelog") return { command: "changelog", base, outPath, outProvided, llm }
	if (command === "release-notes") return { command: "release-notes", base, outPath, outProvided, llm }
	if (command === "prepublish") {
		return {
			command: "prepublish",
			projectType,
			manifestPath,
			writeManifest,
			packageJsonPath,
			changelogOutPath: outPath,
			outProvided,
			llm
		}
	}
	if (command === "postpublish") return { command: "postpublish", projectType, manifestPath, llm }
	throw new Error("Internal error: unreachable")
}

async function main() {
	let parsed: ParsedArgs
	try {
		parsed = parseCliArgs(process.argv.slice(2))
	} catch (err: any) {
		// eslint-disable-next-line no-console
		console.error(err?.message ?? String(err))
		usage(2)
	}

	if (parsed.command === "help") usage(0)

	const llmClient =
		parsed.llm === "azure"
			? createAzureOpenAILLMClient()
			: parsed.llm === "openai"
			? createOpenAILLMClient()
			: undefined
	if (!llmClient) throw new Error("LLM client is required")

	let markdown = ""
	let baseUsed: string | undefined
	let baseSource: "explicit" | "tag" | undefined
	let previousTag: string | null | undefined
	let previousVersion: string | undefined
	let baseCommit: string | null | undefined
	let baseLabel: string | undefined
	let headLabel: string | undefined
	let headTag: string | null | undefined

	if (parsed.command === "changelog") {
		if (parsed.base) {
			baseUsed = parsed.base
			baseSource = "explicit"
			baseLabel = parsed.base
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"
		} else {
			const resolved = await resolveVersionBaseFromGitTags({ cwd: process.cwd() })
			baseUsed = resolved.base
			baseSource = "tag"
			previousTag = resolved.previousTag
			previousVersion = resolved.previousVersion
			baseCommit = resolved.baseCommit
			baseLabel = resolved.previousTag ?? resolved.base
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"
		}
		const generated = await runChangelogPipeline({ base: baseUsed, baseLabel, headLabel, llmClient })
		const validation = validateChangelogModel(generated.model)
		if (!validation.ok) {
			throw new Error(`Changelog model validation failed:\n${validation.errors.join("\n")}`)
		}
		markdown = generated.markdown
	} else if (parsed.command === "release-notes") {
		if (parsed.base) {
			baseUsed = parsed.base
			baseSource = "explicit"
			baseLabel = parsed.base
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"
		} else {
			const resolved = await resolveVersionBaseFromGitTags({ cwd: process.cwd() })
			baseUsed = resolved.base
			baseSource = "tag"
			previousTag = resolved.previousTag
			previousVersion = resolved.previousVersion
			baseCommit = resolved.baseCommit
			baseLabel = resolved.previousTag ?? resolved.base
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"
		}

		// Default output behavior (when --out is not provided):
		// - If HEAD is already tagged v<semver>, write to release-notes/<tag>.md.
		// - Otherwise (most common), compute the next version tag and write to release-notes/v<next>.md.
		if (!parsed.outProvided) {
			if (headTag) {
				parsed.outPath = join("release-notes", `${headTag}.md`)
				headLabel = headTag
			} else if (!parsed.base) {
				const bumped = await runVersionBumpPipeline({
					cwd: process.cwd(),
					llmClient,
					manifest: { type: "npm", path: "package.json", write: false }
				})
				const predictedTag = `v${bumped.nextVersion}`
				parsed.outPath = join("release-notes", `${predictedTag}.md`)
				headLabel = predictedTag
			}
		}
		const generated = await runReleaseNotesPipeline({ base: baseUsed, baseLabel, headLabel, llmClient })
		markdown = generated.markdown
	} else if (parsed.command === "prepublish") {
		const pre = await runPrepublishPipeline({
			cwd: process.cwd(),
			llmClient,
			packageJsonPath: parsed.packageJsonPath,
			manifest: {
				type: parsed.projectType,
				path: parsed.manifestPath,
				write: parsed.writeManifest
			},
			changelogOutPath: parsed.changelogOutPath
		})
		markdown = ""
		// eslint-disable-next-line no-console
		console.log(JSON.stringify(pre, null, 2))
		return
	} else if (parsed.command === "postpublish") {
		const post = await runPostpublishPipeline({
			cwd: process.cwd(),
			remote: "origin",
			projectType: parsed.projectType,
			manifestPath: parsed.manifestPath,
			llmClient
		})
		markdown = ""
		// eslint-disable-next-line no-console
		console.log(JSON.stringify(post, null, 2))
		return
	}

	let absOut: string | undefined
	if (parsed.command === "changelog" || parsed.command === "release-notes") {
		absOut = resolve(process.cwd(), parsed.outPath)
	}
	if (parsed.command === "changelog") {
		await mkdir(dirname(absOut!), { recursive: true })
		await writeFileAtomic(absOut!, markdown)
	} else if (parsed.command === "release-notes") {
		await mkdir(dirname(absOut!), { recursive: true })
		await writeFile(absOut!, markdown, "utf8")
	}

	// eslint-disable-next-line no-console
	console.log(
		JSON.stringify(
			{
				out: absOut,
				llm: parsed.llm,
				base: baseUsed,
				baseSource,
				baseCommit,
				previousTag,
				previousVersion,
				headTag
			},
			null,
			2
		)
	)
}

declare const require: NodeRequire | undefined
if (typeof require !== "undefined" && require.main === module) {
	main().catch((err) => {
		// eslint-disable-next-line no-console
		console.error(err?.message ?? String(err))
		process.exit(1)
	})
}
