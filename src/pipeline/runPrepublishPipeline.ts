import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname, join, relative } from "node:path"
import semver from "semver"
import type { LLMClient } from "../llm/types"
import { resolveHeadVersionTagFromGitTags, resolveVersionBaseFromGitTags } from "../version/resolveVersionBase"
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
import { assertCleanWorktree, createAnnotatedTag, createReleaseCommit, tagExists } from "../git/release"
import { buildReleaseTagMessage } from "../changelog/tagSummary"

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1"
}

function debugLog(...args: any[]) {
	if (!debugEnabled()) return
	// eslint-disable-next-line no-console
	console.error("[ai-publish][debug]", ...args)
}

function toGitPath(pathFromCwd: string): string {
	return pathFromCwd.replace(/\\/g, "/")
}

function patchChangelogHeaderRange(markdown: string, headLabel: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n")
	if (!lines.length) return markdown
	const first = lines[0] ?? ""
	const m = /^# Changelog \((.+)\.\.(.+)\)$/.exec(first.trim())
	if (!m) return markdown
	const baseDisplay = m[1]!
	lines[0] = `# Changelog (${baseDisplay}..${headLabel})`
	return lines.join("\n")
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
	manifest?: ManifestTarget
	/** Backwards-compatible alias for npm manifests. Prefer `manifest`. */
	packageJsonPath?: string
	changelogOutPath?: string
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
	commitSha: string
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

	const resolvedBase = await resolveVersionBaseFromGitTags({ cwd })
	debugLog("prepublishPipeline:base", {
		base: resolvedBase.base,
		previousTag: resolvedBase.previousTag,
		previousVersion: resolvedBase.previousVersion
	})
	const base = resolvedBase.base
	const baseLabel = resolvedBase.previousTag ?? resolvedBase.base

	// Generate changelog first (authority is base..pre-release HEAD). We'll patch the header to the predicted tag later.
	const changelogGenerated = await runChangelogPipeline({
		base,
		baseLabel,
		headLabel: "HEAD",
		cwd,
		llmClient: params.llmClient
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
		throw new Error("No user-facing changes detected (bumpType=none). Refusing to create a release commit/tag.")
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
		llmClient: params.llmClient
	})
	debugLog("prepublishPipeline:releaseNotesBytes", releaseNotesGenerated.markdown.length)

	// Prepare output paths.
	const changelogOutPath = params.changelogOutPath ?? "CHANGELOG.md"
	const absChangelogPath = resolve(cwd, changelogOutPath)
	const relChangelogPath = toGitPath(relative(cwd, absChangelogPath))
	const releaseNotesRelPath = toGitPath(join("release-notes", `${predictedTag}.md`))
	const absReleaseNotesPath = resolve(cwd, releaseNotesRelPath)

	// Determine manifest target.
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
	await writeFileAtomic(absChangelogPath, patchedChangelogMarkdown)
	debugLog("prepublishPipeline:wrote", changelogOutPath)

	// Write release notes.
	await mkdir(dirname(absReleaseNotesPath), { recursive: true })
	await writeFile(absReleaseNotesPath, releaseNotesGenerated.markdown, "utf8")
	debugLog("prepublishPipeline:wrote", releaseNotesRelPath)

	const pathsToCommit = [relChangelogPath, releaseNotesRelPath]
	if (shouldWriteManifest) pathsToCommit.push(relManifestPath)

	// Create release commit, then annotated tag.
	const commitMessage = `chore(release): ${predictedTag}`
	const { commitSha } = await createReleaseCommit({ cwd, paths: pathsToCommit, message: commitMessage })
	debugLog("prepublishPipeline:commit", commitSha)
	const tagMessage = buildReleaseTagMessage({ tag: predictedTag, bumpType, model: changelogGenerated.model })
	await createAnnotatedTag({ cwd, tag: predictedTag, message: tagMessage })
	debugLog("prepublishPipeline:tagged", predictedTag)

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
		commitSha
	}
}
