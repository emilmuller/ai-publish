import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import semver from "semver"
import type { LLMClient } from "../llm/types"
import { runChangelogPipeline } from "./runChangelogPipeline"
import { resolveVersionBase } from "../version/resolveVersionBase"
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
import type { ClassifyOverrides } from "../classify/classifyFile"

export async function runVersionBumpPipeline(params: {
	cwd?: string
	llmClient: LLMClient
	/** Optional override for diff index root dir (defaults to <cwd>/.ai-publish/diff-index). */
	indexRootDir?: string
	tagPrefix?: string
	/** Optional override for previous version (useful for first-run repos without tags). */
	previousVersion?: string
	/** Optional override for how previousVersion is inferred when no tags exist. */
	previousVersionSource?: "manifest" | "manifest-history"
	/** Optional override for base revision (useful to force a diff boundary). */
	base?: string
	/** Backwards-compatible alias for npm manifests. Prefer `manifest`. */
	packageJsonPath?: string
	/** Which project manifest to update. Defaults to `{ type: "npm", path: "package.json", write: true }`. */
	manifest?: ManifestTarget
	/** Optional default surface classification overrides applied to all files (may be further overridden by repo instructions). */
	defaultClassifyOverrides?: ClassifyOverrides
}): Promise<{
	previousVersion: string
	previousTag: string | null
	base: string
	bumpType: "major" | "minor" | "patch" | "none"
	nextVersion: string
	justification: string
	manifestType: ManifestType
	manifestPath: string
	updated: boolean
}> {
	const cwd = params.cwd ?? process.cwd()

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
	if (!manifestRelPath) {
		throw new Error(`Missing manifest path for type: ${manifestType}`)
	}
	const absManifestPath = resolve(cwd, manifestRelPath)
	const shouldWrite = manifest.write ?? true

	const resolvedBase = await resolveVersionBase({
		cwd,
		tagPrefix: params.tagPrefix,
		manifest: { type: manifestType, path: manifestRelPath, write: false },
		previousVersionOverride: params.previousVersion,
		previousVersionSource: params.previousVersionSource,
		baseOverride: params.base
	})
	const previousVersion = resolvedBase.previousVersion

	const changelog = await runChangelogPipeline({
		base: resolvedBase.base,
		cwd,
		indexRootDir: params.indexRootDir,
		llmClient: params.llmClient,
		defaultClassifyOverrides: params.defaultClassifyOverrides
	})
	const bumpType = computeBumpTypeFromChangelogModel(changelog.model)
	const nextVersion = computeNextVersion({ previousVersion, bumpType })

	if (bumpType !== "none") {
		assertVersionIncreases(previousVersion, nextVersion)
	}

	const llmOut = await params.llmClient.pass3VersionBump({
		previousVersion,
		bumpType,
		nextVersion,
		changelogModel: changelog.model
	})

	const llmNext = semver.valid(llmOut.nextVersion)
	const expectedNext = semver.valid(nextVersion)
	if (!llmNext) throw new Error(`LLM produced invalid nextVersion (not semver): ${llmOut.nextVersion}`)
	if (!expectedNext) throw new Error(`Internal error: computed nextVersion invalid: ${nextVersion}`)
	if (!semver.eq(llmNext, expectedNext)) {
		throw new Error(`LLM nextVersion mismatch (expected ${expectedNext}, got ${llmNext})`)
	}

	const justification = (llmOut.justification ?? "").trim()
	if (!justification) throw new Error("LLM produced empty justification")

	let updated = false
	if (bumpType !== "none" && shouldWrite) {
		const raw = await readFile(absManifestPath, "utf8")
		let nextContent: string
		if (manifestType === "npm") {
			nextContent = updateNpmPackageJsonVersion(raw, expectedNext)
		} else if (manifestType === "dotnet") {
			nextContent = updateCsprojVersion(raw, expectedNext)
		} else if (manifestType === "python") {
			nextContent = updatePyProjectTomlVersion(raw, expectedNext)
		} else if (manifestType === "go") {
			nextContent = updateGoModVersion(raw, expectedNext)
		} else {
			nextContent = updateCargoTomlVersion(raw, expectedNext)
		}
		if (nextContent !== raw) {
			await writeFileAtomic(absManifestPath, nextContent)
			updated = true
		}
	}

	return {
		previousVersion,
		previousTag: resolvedBase.previousTag,
		base: resolvedBase.base,
		bumpType,
		nextVersion: expectedNext,
		justification,
		manifestType,
		manifestPath: absManifestPath,
		updated
	}
}
