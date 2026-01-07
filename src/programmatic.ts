import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { dirname, join } from "node:path"
import { validateChangelogModel } from "./changelog/validate"
import { extractFirstKeepAChangelogEntry, upsertKeepAChangelogEntry } from "./changelog/prepend"
import { createAzureOpenAILLMClient } from "./llm/azureOpenAI"
import { createOpenAILLMClient } from "./llm/openAI"
import type { LLMClient } from "./llm/types"
import { runChangelogPipeline } from "./pipeline/runChangelogPipeline"
import { runReleaseNotesPipeline } from "./pipeline/runReleaseNotesPipeline"
import { runVersionBumpPipeline } from "./pipeline/runVersionBumpPipeline"
import { runPrepublishPipeline } from "./pipeline/runPrepublishPipeline"
import { runPostpublishPipeline, type PublishRunner } from "./pipeline/runPostpublishPipeline"
import { writeFileAtomic } from "./util/fs"
import { resolveHeadVersionTagFromGitTags, resolveVersionBaseFromGitTags } from "./version/resolveVersionBase"
import type { ManifestTarget, ManifestType } from "./version/manifests"

export type CommonGenerateArgs = {
	/** Git base revision (same as CLI `--base`). If omitted, defaults to previous version tag commit (v<semver>) or empty tree. */
	base?: string
	/** Output path (same as CLI `--out`). */
	outPath?: string
	/** LLM provider (same as CLI `--llm`). */
	llm: "azure" | "openai"
	/** Working directory to run in (defaults to `process.cwd()`). */
	cwd?: string
	/** Optional injection for testing/offline use. If provided, `llm` is still required for CLI parity. */
	llmClient?: LLMClient
}

export type GenerateChangelogResult = {
	markdown: string
	model: unknown
	outPath: string
	llm: "azure" | "openai"
}

export type GenerateChangelogArgs = CommonGenerateArgs

export type GenerateReleaseNotesResult = {
	markdown: string
	releaseNotes: unknown
	outPath: string
	llm: "azure" | "openai"
}

export type PrepublishArgs = {
	/** Backwards-compatible alias for npm manifests. Prefer `manifest`. */
	packageJsonPath?: string
	/** Which project manifest to update. Defaults to `{ type: "npm", path: "package.json", write: true }`. */
	manifest?: ManifestTarget
	/** Changelog output path (same as CLI `prepublish --out`). */
	changelogOutPath?: string
	/** LLM provider (same as CLI `--llm`). */
	llm: "azure" | "openai"
	/** Working directory to run in (defaults to `process.cwd()`). */
	cwd?: string
	/** Optional injection for testing/offline use. If provided, `llm` is still required for CLI parity. */
	llmClient?: LLMClient
}

export type PrepublishResult = {
	previousVersion: string
	previousTag: string | null
	bumpType: "major" | "minor" | "patch" | "none"
	nextVersion: string
	predictedTag: string
	justification: string
	manifestType: ManifestType
	manifestPath: string
	manifestUpdated: boolean
	changelogPath: string
	releaseNotesPath: string
	prepublishStatePath: string
	llm: "azure" | "openai"
}

export type PostpublishArgs = {
	/** Which consumer project type is being published. Defaults to `npm`. */
	projectType?: ManifestType
	/** Git remote to push to. Defaults to `origin`. */
	remote?: string
	/** Optional injection for testing. */
	publishRunner?: PublishRunner
	/** LLM provider (same as CLI `--llm`). Present for parity; not used by postpublish. */
	llm: "azure" | "openai"
	/** Working directory to run in (defaults to `process.cwd()`). */
	cwd?: string
	/** Optional injection for testing/offline use. If provided, `llm` is still required for CLI parity. */
	llmClient?: LLMClient
}

export type PostpublishResult = {
	tag: string
	branch: string
	remote: string
	llm: "azure" | "openai"
}

function getLLMClient(args: CommonGenerateArgs): LLMClient {
	if (args.llmClient) return args.llmClient
	if (args.llm === "azure") return createAzureOpenAILLMClient()
	if (args.llm === "openai") return createOpenAILLMClient()
	throw new Error(`Unsupported LLM provider: ${(args as any).llm}`)
}

/**
 * Programmatic equivalent of:
 * `ai-publish changelog --base <sha> [--out CHANGELOG.md] --llm <azure|openai>`
 */
export async function generateChangelog(args: GenerateChangelogArgs): Promise<GenerateChangelogResult> {
	const cwd = args.cwd ?? process.cwd()
	const outPath = args.outPath ?? "CHANGELOG.md"

	const llmClient = getLLMClient(args)

	const resolved = args.base ? undefined : await resolveVersionBaseFromGitTags({ cwd })
	const head = await resolveHeadVersionTagFromGitTags({ cwd })
	const base = args.base ?? resolved!.base
	const baseLabel = args.base ?? resolved?.previousTag ?? resolved?.base
	const headLabel = head.headTag ?? "HEAD"
	const generated = await runChangelogPipeline({ base, baseLabel, headLabel, cwd, llmClient })
	const validation = validateChangelogModel(generated.model as any)
	if (!validation.ok) {
		throw new Error(`Changelog model validation failed:\n${validation.errors.join("\n")}`)
	}

	const absOut = resolve(cwd, outPath)
	let existing: string | null = null
	try {
		existing = await readFile(absOut, "utf8")
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw e
	}
	if (!existing) {
		await writeFileAtomic(absOut, generated.markdown)
	} else {
		const { entryMarkdown } = extractFirstKeepAChangelogEntry(generated.markdown)
		const next = upsertKeepAChangelogEntry({ existingMarkdown: existing, newEntryMarkdown: entryMarkdown })
		await writeFileAtomic(absOut, next)
	}

	return {
		markdown: generated.markdown,
		model: generated.model,
		outPath: absOut,
		llm: args.llm
	}
}

/**
 * Programmatic equivalent of:
 * `ai-publish release-notes --base <sha> [--out RELEASE_NOTES.md] --llm <azure|openai>`
 */
export async function generateReleaseNotes(args: CommonGenerateArgs): Promise<GenerateReleaseNotesResult> {
	const cwd = args.cwd ?? process.cwd()
	const outProvided = !!args.outPath

	const llmClient = getLLMClient(args)

	const resolved = args.base ? undefined : await resolveVersionBaseFromGitTags({ cwd })
	const head = await resolveHeadVersionTagFromGitTags({ cwd })
	const base = args.base ?? resolved!.base
	const baseLabel = args.base ?? resolved?.previousTag ?? resolved?.base
	let headLabel = head.headTag ?? "HEAD"

	let outPath = args.outPath ?? (head.headTag ? join("release-notes", `${head.headTag}.md`) : "RELEASE_NOTES.md")
	if (!outProvided && !head.headTag && !args.base) {
		const bumped = await runVersionBumpPipeline({
			cwd,
			llmClient,
			manifest: { type: "npm", path: "package.json", write: false }
		})
		const predictedTag = `v${bumped.nextVersion}`
		headLabel = predictedTag
		outPath = join("release-notes", `${predictedTag}.md`)
	}
	const generated = await runReleaseNotesPipeline({ base, baseLabel, headLabel, cwd, llmClient })

	const absOut = resolve(cwd, outPath)
	await mkdir(dirname(absOut), { recursive: true })
	await writeFile(absOut, generated.markdown, "utf8")

	return {
		markdown: generated.markdown,
		releaseNotes: generated.releaseNotes,
		outPath: absOut,
		llm: args.llm
	}
}

/**
 * Programmatic equivalent of:
 * `ai-publish prepublish [--out CHANGELOG.md] --llm <azure|openai>`
 */
export async function prepublish(args: PrepublishArgs): Promise<PrepublishResult> {
	const cwd = args.cwd ?? process.cwd()
	const llmClient = getLLMClient({ llm: args.llm, cwd, llmClient: args.llmClient })

	const res = await runPrepublishPipeline({
		cwd,
		llmClient,
		packageJsonPath: args.packageJsonPath,
		manifest: args.manifest,
		changelogOutPath: args.changelogOutPath
	})

	return { ...res, llm: args.llm }
}

/**
 * Programmatic equivalent of:
 * `ai-publish postpublish --llm <azure|openai>`
 */
export async function postpublish(args: PostpublishArgs): Promise<PostpublishResult> {
	const cwd = args.cwd ?? process.cwd()
	const llmClient = getLLMClient({ llm: args.llm, cwd, llmClient: args.llmClient })

	const res = await runPostpublishPipeline({
		cwd,
		remote: args.remote,
		projectType: args.projectType,
		publishRunner: args.publishRunner,
		llmClient
	})

	return { ...res, llm: args.llm }
}
