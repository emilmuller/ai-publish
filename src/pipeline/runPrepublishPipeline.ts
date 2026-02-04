import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname, join, relative } from "node:path"
import semver from "semver"
import type { LLMClient } from "../llm/types"
import { resolveHeadVersionTagFromGitTags, resolveVersionBase } from "../version/resolveVersionBase"
import { runChangelogPipeline } from "./runChangelogPipeline"
import { runReleaseNotesPipeline } from "./runReleaseNotesPipeline"
import { computeBumpTypeFromChangelogModel, computeNextVersion, assertVersionIncreases } from "../version/bump"
import { writeFileAtomic } from "../util/fs"
import type { ManifestTarget, ManifestType } from "../version/manifests"
import {
	updateCargoTomlVersion,
	updateCsprojVersion,
	updateGoModVersion,
	updateNpmPackageJsonVersion,
	updatePyProjectTomlVersion
} from "../version/manifests"
import { assertCleanWorktree, tagExists } from "../git/release"
import { buildReleaseTagMessage } from "../changelog/tagSummary"
import { extractFirstKeepAChangelogEntry, prependKeepAChangelogEntry } from "../changelog/prepend"
import type { ClassifyOverrides } from "../classify/classifyFile"

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1"
}

function debugLog(...args: unknown[]) {
	if (!debugEnabled()) return

	console.error("[ai-publish][debug]", ...args)
}

function toGitPath(pathFromCwd: string): string {
	return pathFromCwd.replace(/\\/g, "/")
}

function patchChangelogHeaderRange(markdown: string, headLabel: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n")
	if (!lines.length) return markdown

	const normalizedHead = headLabel.replace(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i, "$1")

	// Replace the first version heading: "## [X] - YYYY-MM-DD".
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim()
		const m = /^##\s+\[([^\]]+)\](\s+-\s+\d{4}-\d{2}-\d{2})?$/.exec(line)
		if (!m) continue
		const suffix = m[2] ?? ""
		lines[i] = `## [${normalizedHead}]${suffix}`
		return lines.join("\n")
	}

	return markdown
}

function updateManifestContent(params: { type: ManifestType; raw: string; nextVersion: string }): string {
	if (params.type === "npm") return updateNpmPackageJsonVersion(params.raw, params.nextVersion)
	if (params.type === "dotnet") return updateCsprojVersion(params.raw, params.nextVersion)
	if (params.type === "python") return updatePyProjectTomlVersion(params.raw, params.nextVersion)
	if (params.type === "go") return updateGoModVersion(params.raw, params.nextVersion)
	return updateCargoTomlVersion(params.raw, params.nextVersion)
}

export async function runPrepublishPipeline(params: {
	cwd?: string
	llmClient: LLMClient
	/** Optional override for diff index root dir (defaults to <cwd>/.ai-publish/diff-index). */
	indexRootDir?: string
	manifest?: ManifestTarget
	/** Backwards-compatible alias for npm manifests. Prefer `manifest`. */
	packageJsonPath?: string
	changelogOutPath?: string
	/** Optional override for base revision (useful for first-run repos without tags). */
	base?: string
	/** Optional override for previous version (useful for first-run repos without tags and go projects). */
	previousVersion?: string
	/** Optional override for how previousVersion is inferred when no tags exist. */
	previousVersionSource?: "manifest" | "manifest-history"
}): Promise<{
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
}> {
	const cwd = params.cwd ?? process.cwd()
	debugLog("prepublishPipeline", { cwd })

	debugLog("prepublishPipeline:assertCleanWorktree")
	await assertCleanWorktree({ cwd })
	debugLog("prepublishPipeline:clean")

	const headTagged = await resolveHeadVersionTagFromGitTags({ cwd })
	debugLog("prepublishPipeline:headTag", headTagged.headTag ?? null)
	if (headTagged.headTag) {
		throw new Error(`HEAD is already tagged with ${headTagged.headTag}. Refusing to prepublish twice.`)
	}

	// Determine manifest target early so we can use it for no-tags inference.
	const manifest: ManifestTarget =
		params.manifest ??
		(params.packageJsonPath
			? { type: "npm", path: params.packageJsonPath, write: true }
			: { type: "npm", path: "package.json", write: true })
	const manifestType = manifest.type
	const manifestRelPath =
		manifest.path ??
		(manifestType === "npm"
			? "package.json"
			: manifestType === "rust"
				? "Cargo.toml"
				: manifestType === "python"
					? "pyproject.toml"
					: manifestType === "go"
						? "go.mod"
						: undefined)
	if (!manifestRelPath) throw new Error(`Missing manifest path for type: ${manifestType}`)
	const absManifestPath = resolve(cwd, manifestRelPath)
	const relManifestPath = toGitPath(relative(cwd, absManifestPath))
	const shouldWriteManifest = manifest.write ?? true

	const resolvedBase = await resolveVersionBase({
		cwd,
		manifest: { type: manifestType, path: relManifestPath, write: false },
		baseOverride: params.base,
		previousVersionOverride: params.previousVersion,
		previousVersionSource: params.previousVersionSource
	})
	debugLog("prepublishPipeline:base", {
		base: resolvedBase.base,
		previousTag: resolvedBase.previousTag,
		previousVersion: resolvedBase.previousVersion
	})
	const base = resolvedBase.base
	const baseLabel = resolvedBase.previousTag ?? resolvedBase.base

	// Repo layout hint: for dotnet, treat the manifest project directory as public surface by default.
	// This avoids requiring instruction files for common layouts like "MyLib/MyLib.csproj".
	const defaultClassifyOverrides: ClassifyOverrides | undefined =
		manifestType === "dotnet"
			? (() => {
					const dir = toGitPath(dirname(relManifestPath))
					if (!dir || dir === ".") return undefined
					return { publicPathPrefixes: [dir] }
				})()
			: undefined

	// Generate changelog first (authority is base..pre-release HEAD). We'll patch the header to the predicted tag later.
	const changelogGenerated = await runChangelogPipeline({
		base,
		baseLabel,
		headLabel: "HEAD",
		cwd,
		indexRootDir: params.indexRootDir,
		llmClient: params.llmClient,
		defaultClassifyOverrides
	})
	debugLog("prepublishPipeline:changelogModel", {
		breaking: changelogGenerated.model.breakingChanges.length,
		added: changelogGenerated.model.added.length,
		changed: changelogGenerated.model.changed.length,
		fixed: changelogGenerated.model.fixed.length,
		removed: changelogGenerated.model.removed.length,
		internal: changelogGenerated.model.internalTooling.length
	})
	const bumpType = computeBumpTypeFromChangelogModel(changelogGenerated.model)
	const nextVersion = computeNextVersion({ previousVersion: resolvedBase.previousVersion, bumpType })
	debugLog("prepublishPipeline:computedVersion", { bumpType, nextVersion })

	if (bumpType === "none") {
		const modelCounts = {
			breaking: changelogGenerated.model.breakingChanges.length,
			added: changelogGenerated.model.added.length,
			changed: changelogGenerated.model.changed.length,
			fixed: changelogGenerated.model.fixed.length,
			removed: changelogGenerated.model.removed.length,
			internalTooling: changelogGenerated.model.internalTooling.length
		}
		const prevTagLabel = resolvedBase.previousTag ?? "<none>"
		const baseLabelForError = resolvedBase.previousTag ?? resolvedBase.base
		throw new Error(
			[
				"No user-facing changes detected (bumpType=none). Refusing to prepare a release.",
				"",
				`Resolved previousVersion=${resolvedBase.previousVersion}, previousTag=${prevTagLabel}, base=${baseLabelForError}.`,
				`Changelog section counts: breaking=${modelCounts.breaking}, added=${modelCounts.added}, changed=${modelCounts.changed}, fixed=${modelCounts.fixed}, removed=${modelCounts.removed}, internalTooling=${modelCounts.internalTooling}.`,
				"",
				"This typically means either:",
				"- The diff range contains only internal/tooling/docs changes (which do not trigger a release bump), or",
				"- The computed diff range is empty (base resolves to HEAD).",
				"",
				"If you're bootstrapping a repo with no version tags, either create a baseline version tag for the current version, or run prepublish with explicit --base (and optionally --previous-version) to define the diff range.",
				"To debug base selection, set AI_PUBLISH_DEBUG_CLI=1."
			].join("\n")
		)
	}
	assertVersionIncreases(resolvedBase.previousVersion, nextVersion)

	const predictedTag = `v${nextVersion}`
	debugLog("prepublishPipeline:predictedTag", predictedTag)
	if (await tagExists({ cwd, tag: predictedTag })) {
		throw new Error(`Tag already exists: ${predictedTag}`)
	}

	// LLM justification pass (must match deterministic nextVersion).
	const llmOut = await params.llmClient.pass3VersionBump({
		previousVersion: resolvedBase.previousVersion,
		bumpType,
		nextVersion,
		changelogModel: changelogGenerated.model
	})
	debugLog("prepublishPipeline:llmVersionBump", { nextVersion: llmOut.nextVersion })
	const llmNext = semver.valid(llmOut.nextVersion)
	const expectedNext = semver.valid(nextVersion)
	if (!llmNext) throw new Error(`LLM produced invalid nextVersion (not semver): ${llmOut.nextVersion}`)
	if (!expectedNext) throw new Error(`Internal error: computed nextVersion invalid: ${nextVersion}`)
	if (!semver.eq(llmNext, expectedNext)) {
		throw new Error(`LLM nextVersion mismatch (expected ${expectedNext}, got ${llmNext})`)
	}
	const justification = (llmOut.justification ?? "").trim()
	if (!justification) throw new Error("LLM produced empty justification")

	// Generate release notes using the predicted tag label.
	const releaseNotesGenerated = await runReleaseNotesPipeline({
		base,
		baseLabel,
		headLabel: predictedTag,
		cwd,
		indexRootDir: params.indexRootDir,
		llmClient: params.llmClient,
		defaultClassifyOverrides
	})
	debugLog("prepublishPipeline:releaseNotesBytes", releaseNotesGenerated.markdown.length)

	// Prepare output paths.
	const changelogOutPath = params.changelogOutPath ?? "CHANGELOG.md"
	const absChangelogPath = resolve(cwd, changelogOutPath)
	const relChangelogPath = toGitPath(relative(cwd, absChangelogPath))
	const releaseNotesRelPath = toGitPath(join("release-notes", `${predictedTag}.md`))
	const absReleaseNotesPath = resolve(cwd, releaseNotesRelPath)

	// Write manifest version (if enabled).
	let manifestUpdated = false
	if (shouldWriteManifest) {
		const raw = await readFile(absManifestPath, "utf8")
		const updated = updateManifestContent({ type: manifestType, raw, nextVersion: expectedNext })
		if (updated !== raw) {
			await writeFileAtomic(absManifestPath, updated)
			manifestUpdated = true
		}
	}

	// Write changelog (overwrite).
	const patchedChangelogMarkdown = patchChangelogHeaderRange(changelogGenerated.markdown, predictedTag)
	let existingChangelog: string | null = null
	try {
		existingChangelog = await readFile(absChangelogPath, "utf8")
	} catch (e: unknown) {
		const code = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined
		if (code !== "ENOENT") throw e
	}
	if (!existingChangelog) {
		await writeFileAtomic(absChangelogPath, patchedChangelogMarkdown)
	} else {
		const { entryMarkdown } = extractFirstKeepAChangelogEntry(patchedChangelogMarkdown)
		const next = prependKeepAChangelogEntry({
			existingMarkdown: existingChangelog,
			newEntryMarkdown: entryMarkdown
		})
		await writeFileAtomic(absChangelogPath, next)
	}
	debugLog("prepublishPipeline:wrote", changelogOutPath)

	// Write release notes.
	await mkdir(dirname(absReleaseNotesPath), { recursive: true })
	await writeFile(absReleaseNotesPath, releaseNotesGenerated.markdown, "utf8")
	debugLog("prepublishPipeline:wrote", releaseNotesRelPath)

	const pathsToCommit = [relChangelogPath, releaseNotesRelPath]
	if (shouldWriteManifest) pathsToCommit.push(relManifestPath)

	// Persist release intent so `postpublish` can publish, then create the release commit + tag.
	const tagMessage = buildReleaseTagMessage({ tag: predictedTag, bumpType, model: changelogGenerated.model })
	const prepublishStateRelPath = toGitPath(join(".ai-publish", "prepublish.json"))
	const absPrepublishStatePath = resolve(cwd, prepublishStateRelPath)
	await mkdir(dirname(absPrepublishStatePath), { recursive: true })
	await writeFileAtomic(
		absPrepublishStatePath,
		JSON.stringify(
			{
				predictedTag,
				nextVersion: expectedNext,
				bumpType,
				previousVersion: resolvedBase.previousVersion,
				previousTag: resolvedBase.previousTag,
				manifestType,
				manifestPath: relManifestPath,
				changelogPath: changelogOutPath,
				releaseNotesPath: releaseNotesRelPath,
				pathsToCommit,
				commitMessage: `chore(release): ${predictedTag}`,
				tagMessage
			},
			null,
			2
		) + "\n"
	)
	debugLog("prepublishPipeline:wrote", prepublishStateRelPath)

	return {
		previousVersion: resolvedBase.previousVersion,
		previousTag: resolvedBase.previousTag,
		bumpType,
		nextVersion: expectedNext,
		predictedTag,
		justification,
		manifestType,
		manifestPath: absManifestPath,
		manifestUpdated,
		changelogPath: absChangelogPath,
		releaseNotesPath: absReleaseNotesPath,
		prepublishStatePath: absPrepublishStatePath
	}
}
