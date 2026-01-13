import { writeFile, mkdir } from "node:fs/promises"
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
import { logInfo, markCliProcess } from "./util/logger"
import { runGitOrThrow } from "./git/runGit"
import {
	resolveHeadVersionTagFromGitTags,
	resolveVersionBaseBeforeHeadTagFromGitTags,
	resolveVersionBaseFromGitTags
} from "./version/resolveVersionBase"

async function tryResolveCommitSha(cwd: string, rev: string): Promise<string | null> {
	try {
		return (await runGitOrThrow(["rev-parse", `${rev}^{commit}`], { cwd })).trim()
	} catch {
		return null
	}
}

export async function applyAutoNamingBumpToCliSummary(params: {
	current: {
		baseUsed?: string
		baseCommit?: string | null
		baseSource?: "explicit" | "tag" | "manifest"
		baseLabel?: string
		previousTag?: string | null
		previousVersion?: string
	}
	bumped: {
		base: string
		previousVersion: string
	}
	resolveCommitSha: (rev: string) => Promise<string | null>
}): Promise<{
	baseUsed: string
	baseCommit: string | null | undefined
	baseSource: "explicit" | "tag" | "manifest" | undefined
	baseLabel: string
	previousVersion: string
}> {
	const baseUsed = params.bumped.base
	const previousVersion = params.bumped.previousVersion
	const baseCommit = params.current.baseCommit ?? (await params.resolveCommitSha(baseUsed))
	// In tagless repos, version-bump derives base from manifest history, not tags.
	const baseSource = params.current.previousTag ? params.current.baseSource : "manifest"
	const baseLabel = params.current.previousTag ?? baseUsed

	return { baseUsed, baseCommit, baseSource, baseLabel, previousVersion }
}

type ParsedArgs =
	| { command: "help" }
	| {
			command: "changelog"
			base?: string
			outPath: string
			outProvided: boolean
			indexRootDir?: string
			commitContext?: {
				mode: "none" | "snippet" | "full"
				maxCommits?: number
				maxTotalBytes?: number
			}
			llm: "azure" | "openai"
	  }
	| {
			command: "release-notes"
			base?: string
			previousVersion?: string
			outPath: string
			outProvided: boolean
			indexRootDir?: string
			commitContext?: {
				mode: "none" | "snippet" | "full"
				maxCommits?: number
				maxTotalBytes?: number
			}
			llm: "azure" | "openai"
	  }
	| {
			command: "prepublish"
			base?: string
			previousVersion?: string
			projectType: "npm" | "dotnet" | "rust" | "python" | "go"
			manifestPath?: string
			writeManifest: boolean
			packageJsonPath?: string
			changelogOutPath: string
			outProvided: boolean
			indexRootDir?: string
			llm: "azure" | "openai"
	  }
	| {
			command: "postpublish"
			projectType: "npm" | "dotnet" | "rust" | "python" | "go"
			manifestPath?: string
			publishCommand?: string
			skipPublish?: boolean
			llm?: "azure" | "openai"
	  }

export function formatUsage(): string {
	return [
		"Usage:",
		"  ai-publish changelog [--base <commit>] [--out <path>] [--index-root-dir <path>] --llm <azure|openai> [--commit-context <none|snippet|full>] [--commit-context-bytes <n>] [--commit-context-commits <n>] [--debug]",
		"  ai-publish release-notes [--base <commit>] [--previous-version <semver>] [--out <path>] [--index-root-dir <path>] --llm <azure|openai> [--commit-context <none|snippet|full>] [--commit-context-bytes <n>] [--commit-context-commits <n>] [--debug]",
		"  ai-publish prepublish [--base <commit>] [--previous-version <semver>] [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--package <path>] [--no-write] [--out <path>] [--index-root-dir <path>] --llm <azure|openai> [--debug]",
		"  ai-publish postpublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--publish-command <cmd>] [--skip-publish] [--debug]",
		"  ai-publish --help",
		"",
		"Notes:",
		"  - LLM mode is required for changelog/release-notes/prepublish; use --llm azure or --llm openai.",
		"  - --debug enables verbose stderr diagnostics.",
		"  - If --base is omitted, changelog/release-notes diff from the previous version tag commit (v<semver>) when present, otherwise from the empty tree.",
		"  - prepublish/version-bump: when no tags exist, previousVersion is inferred from the selected manifest (or set via --previous-version), and base may be inferred from manifest history.",
		"  - Commit messages are enabled by default as untrusted hints (never treated as evidence of changes).",
		"    - Default: --commit-context snippet --commit-context-bytes 65536 --commit-context-commits 200",
		"    - Disable: --commit-context none",
		"  - --package is a backwards-compatible alias for npm manifests (prepublish only); it implies --project-type npm.",
		"  - Unknown flags are rejected."
	].join("\n")
}

function usage(exitCode: number): never {
	console.error(formatUsage())
	process.exit(exitCode)
}

function debugEnabledFromEnv(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1" || process.env.AI_PUBLISH_DEBUG === "1"
}

function debugLog(...args: unknown[]) {
	if (!debugEnabledFromEnv()) return

	console.error("[ai-publish][debug]", ...args)
}

function takeValue(args: string[], i: number, flag: string): string {
	const v = args[i + 1]
	if (!v || v.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`)
	}
	return v
}

function isProjectType(v: string): v is "npm" | "dotnet" | "rust" | "python" | "go" {
	return v === "npm" || v === "dotnet" || v === "rust" || v === "python" || v === "go"
}

function isLLMProvider(v: string): v is "azure" | "openai" {
	return v === "azure" || v === "openai"
}

function parseIntFlag(v: string, flag: string): number {
	const n = Number(v)
	if (!Number.isFinite(n) || Math.trunc(n) !== n) throw new Error(`Invalid integer for ${flag}: ${v}`)
	return n
}

function isCommitContextMode(v: string): v is "none" | "snippet" | "full" {
	return v === "none" || v === "snippet" || v === "full"
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
	let previousVersion: string | undefined
	let commitContextMode: "none" | "snippet" | "full" | undefined
	let commitContextBytes: number | undefined
	let commitContextCommits: number | undefined
	let indexRootDir: string | undefined
	let publishCommand: string | undefined
	let skipPublish = false

	const seenFlags = new Set<string>()

	for (let i = 1; i < args.length; i++) {
		const token = args[i]!

		if (!token.startsWith("--")) {
			throw new Error(`Unexpected argument: ${token}`)
		}

		// Debug is handled by main() (env + stderr logging). Parse accepts it so it's not rejected.
		if (token === "--debug") continue

		if (seenFlags.has(token)) {
			throw new Error(`Duplicate flag: ${token}`)
		}
		seenFlags.add(token)

		switch (token) {
			case "--base": {
				if (command !== "changelog" && command !== "release-notes" && command !== "prepublish") {
					throw new Error(
						`--base is only supported for ${"changelog"}, ${"release-notes"} and ${"prepublish"}`
					)
				}
				base = takeValue(args, i, token)
				i += 1
				break
			}
			case "--previous-version": {
				if (command !== "release-notes" && command !== "prepublish") {
					throw new Error("--previous-version is only supported for release-notes and prepublish")
				}
				previousVersion = takeValue(args, i, token)
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
				if (!isProjectType(v)) throw new Error(`Unsupported project type: ${v}`)
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
				if (command === "postpublish") {
					throw new Error("--llm is not supported for postpublish")
				}
				const v = takeValue(args, i, token)
				if (!isLLMProvider(v)) throw new Error(`Unsupported LLM provider: ${v}`)
				llm = v
				i += 1
				break
			}
			case "--commit-context": {
				if (command !== "changelog" && command !== "release-notes") {
					throw new Error("--commit-context is only supported for changelog and release-notes")
				}
				const v = takeValue(args, i, token)
				if (!isCommitContextMode(v)) throw new Error(`Unsupported commit context mode: ${v}`)
				commitContextMode = v
				i += 1
				break
			}
			case "--commit-context-bytes": {
				if (command !== "changelog" && command !== "release-notes") {
					throw new Error("--commit-context-bytes is only supported for changelog and release-notes")
				}
				commitContextBytes = parseIntFlag(takeValue(args, i, token), token)
				i += 1
				break
			}
			case "--commit-context-commits": {
				if (command !== "changelog" && command !== "release-notes") {
					throw new Error("--commit-context-commits is only supported for changelog and release-notes")
				}
				commitContextCommits = parseIntFlag(takeValue(args, i, token), token)
				i += 1
				break
			}
			case "--index-root-dir": {
				if (command !== "changelog" && command !== "release-notes" && command !== "prepublish") {
					throw new Error("--index-root-dir is only supported for changelog, release-notes and prepublish")
				}
				indexRootDir = takeValue(args, i, token)
				i += 1
				break
			}
			case "--publish-command": {
				if (command !== "postpublish") {
					throw new Error("--publish-command is only supported for postpublish")
				}
				publishCommand = takeValue(args, i, token)
				i += 1
				break
			}
			case "--skip-publish": {
				if (command !== "postpublish") {
					throw new Error("--skip-publish is only supported for postpublish")
				}
				skipPublish = true
				break
			}
			default:
				throw new Error(`Unknown flag: ${token}`)
		}
	}

	if (command !== "postpublish" && !llm) throw new Error("Missing required flag: --llm")

	// Commit messages are untrusted context-only hints.
	// Enable by default for changelog/release-notes, with conservative budgets.
	const DEFAULT_COMMIT_CONTEXT_MODE = "snippet" as const
	const DEFAULT_COMMIT_CONTEXT_BYTES = 64 * 1024
	const DEFAULT_COMMIT_CONTEXT_COMMITS = 200

	const shouldHaveCommitContext = command === "changelog" || command === "release-notes"
	const resolvedCommitContextMode = shouldHaveCommitContext
		? (commitContextMode ?? DEFAULT_COMMIT_CONTEXT_MODE)
		: undefined

	const commitContext = !resolvedCommitContextMode
		? undefined
		: resolvedCommitContextMode === "none"
			? { mode: "none" as const }
			: {
					mode: resolvedCommitContextMode,
					maxTotalBytes: commitContextBytes ?? DEFAULT_COMMIT_CONTEXT_BYTES,
					maxCommits: commitContextCommits ?? DEFAULT_COMMIT_CONTEXT_COMMITS
				}

	if (command === "changelog") {
		return {
			command: "changelog",
			base,
			outPath,
			outProvided,
			commitContext,
			llm: llm!,
			...(indexRootDir ? { indexRootDir } : {})
		}
	}
	if (command === "release-notes") {
		return {
			command: "release-notes",
			base,
			previousVersion,
			outPath,
			outProvided,
			commitContext,
			llm: llm!,
			...(indexRootDir ? { indexRootDir } : {})
		}
	}
	if (command === "prepublish") {
		return {
			command: "prepublish",
			base,
			previousVersion,
			projectType,
			manifestPath,
			writeManifest,
			packageJsonPath,
			changelogOutPath: outPath,
			outProvided,
			llm: llm!,
			...(indexRootDir ? { indexRootDir } : {})
		}
	}
	if (command === "postpublish") {
		if (skipPublish && publishCommand) {
			throw new Error("--skip-publish and --publish-command are mutually exclusive")
		}
		return { command: "postpublish", projectType, manifestPath, publishCommand, skipPublish, llm }
	}
	throw new Error("Internal error: unreachable")
}

async function main() {
	markCliProcess()
	const rawArgv = process.argv.slice(2)
	const debug = debugEnabledFromEnv() || rawArgv.includes("--debug")
	if (debug && process.env.AI_PUBLISH_DEBUG_CLI !== "1") process.env.AI_PUBLISH_DEBUG_CLI = "1"
	debugLog("argv", rawArgv)

	let parsed: ParsedArgs
	try {
		parsed = parseCliArgs(rawArgv)
	} catch (err: unknown) {
		console.error(err instanceof Error ? err.message : String(err))
		if (debug && err instanceof Error && err.stack) console.error(err.stack)
		usage(2)
	}

	if (parsed.command === "help") usage(0)

	logInfo("cli:command", { command: parsed.command })

	const llmClient =
		parsed.command === "postpublish"
			? undefined
			: parsed.llm === "azure"
				? createAzureOpenAILLMClient()
				: parsed.llm === "openai"
					? createOpenAILLMClient()
					: undefined
	if (parsed.command !== "postpublish" && !llmClient) throw new Error("LLM client is required")

	let markdown = ""
	let baseUsed: string | undefined
	let baseSource: "explicit" | "tag" | "manifest" | undefined
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
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"

			const resolved = resolvedHead.headTag
				? await resolveVersionBaseBeforeHeadTagFromGitTags({ cwd: process.cwd() })
				: await resolveVersionBaseFromGitTags({ cwd: process.cwd() })
			baseUsed = resolved.base
			baseSource = "tag"
			previousTag = resolved.previousTag
			previousVersion = resolved.previousVersion
			baseCommit = resolved.baseCommit
			baseLabel = resolved.previousTag ?? resolved.base
		}
		const generated = await runChangelogPipeline({
			base: baseUsed,
			baseLabel,
			headLabel,
			llmClient: llmClient!,
			indexRootDir: parsed.indexRootDir,
			commitContext: parsed.commitContext
		})
		// (llmClient is required for changelog)
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
			const resolvedHead = await resolveHeadVersionTagFromGitTags({ cwd: process.cwd() })
			headTag = resolvedHead.headTag
			headLabel = resolvedHead.headTag ?? "HEAD"

			const resolved = resolvedHead.headTag
				? await resolveVersionBaseBeforeHeadTagFromGitTags({ cwd: process.cwd() })
				: await resolveVersionBaseFromGitTags({ cwd: process.cwd() })
			baseUsed = resolved.base
			baseSource = "tag"
			previousTag = resolved.previousTag
			previousVersion = resolved.previousVersion
			baseCommit = resolved.baseCommit
			baseLabel = resolved.previousTag ?? resolved.base
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
					llmClient: llmClient!,
					indexRootDir: parsed.indexRootDir,
					previousVersion: parsed.previousVersion,
					manifest: { type: "npm", path: "package.json", write: false }
				})
				const predictedTag = `v${bumped.nextVersion}`

				// Keep JSON summary consistent: when auto-naming via version bump, use the same
				// resolved base/previousVersion that the bump pipeline used.
				const updated = await applyAutoNamingBumpToCliSummary({
					current: { baseUsed, baseCommit, baseSource, baseLabel, previousTag, previousVersion },
					bumped: { base: bumped.base, previousVersion: bumped.previousVersion },
					resolveCommitSha: (rev) => tryResolveCommitSha(process.cwd(), rev)
				})
				previousVersion = updated.previousVersion
				baseUsed = updated.baseUsed
				baseCommit = updated.baseCommit
				baseSource = updated.baseSource
				baseLabel = updated.baseLabel

				parsed.outPath = join("release-notes", `${predictedTag}.md`)
				headLabel = predictedTag
			}
		}
		const generated = await runReleaseNotesPipeline({
			base: baseUsed,
			baseLabel,
			headLabel,
			llmClient: llmClient!,
			indexRootDir: parsed.indexRootDir,
			commitContext: parsed.commitContext
		})
		markdown = generated.markdown
	} else if (parsed.command === "prepublish") {
		const pre = await runPrepublishPipeline({
			cwd: process.cwd(),
			llmClient: llmClient!,
			indexRootDir: parsed.indexRootDir,
			base: parsed.base,
			previousVersion: parsed.previousVersion,
			packageJsonPath: parsed.packageJsonPath,
			manifest: {
				type: parsed.projectType,
				path: parsed.manifestPath,
				write: parsed.writeManifest
			},
			changelogOutPath: parsed.changelogOutPath
		})
		markdown = ""

		console.log(JSON.stringify(pre, null, 2))
		return
	} else if (parsed.command === "postpublish") {
		const post = await runPostpublishPipeline({
			cwd: process.cwd(),
			remote: "origin",
			projectType: parsed.projectType,
			manifestPath: parsed.manifestPath,
			publishCommand: parsed.publishCommand,
			skipPublish: parsed.skipPublish
		})
		markdown = ""

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
		console.error(err?.message ?? String(err))
		process.exit(1)
	})
}
