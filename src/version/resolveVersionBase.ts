import semver from "semver"
import { readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import { runGitOrThrow } from "../git/runGit"
import type { ManifestTarget, ManifestType } from "./manifests"
import {
	readCargoTomlVersion,
	readCsprojVersion,
	readNpmPackageJsonVersion,
	readPyProjectTomlVersion
} from "./manifests"

export type ResolvedVersionBase = {
	/** Previous version string without leading tag prefix (e.g. "1.2.3-beta.1"). */
	previousVersion: string
	/** The git tag selected as previous version (e.g. "v1.2.3"), if any. */
	previousTag: string | null
	/** The base git object id to diff against (tag commit, or empty tree hash when no tags). */
	base: string
	/** The commit id associated with the previous tag, if any (null when no tags). */
	baseCommit: string | null
}

export type ResolvedHeadVersionTag = {
	/** The git tag pointing at HEAD (e.g. "v1.2.3"), if any. */
	headTag: string | null
	/** Version string without leading tag prefix (e.g. "1.2.3"), if any. */
	headVersion: string | null
}

function stripTagPrefix(tag: string, prefix: string): string {
	return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag
}

function toGitPath(pathFromCwd: string): string {
	return pathFromCwd.replace(/\\/g, "/")
}

function normalizeSemverOrThrow(raw: string, label: string): string {
	const trimmed = raw.trim()
	const v = semver.valid(trimmed) ?? (trimmed.startsWith("v") ? semver.valid(trimmed.slice(1)) : null)
	if (!v) throw new Error(`${label} is not valid semver: ${raw}`)
	return v
}

function defaultManifestPath(type: ManifestType): string | null {
	if (type === "npm") return "package.json"
	if (type === "rust") return "Cargo.toml"
	if (type === "python") return "pyproject.toml"
	if (type === "go") return "go.mod"
	// dotnet has no single conventional default filename
	return null
}

async function getEmptyTreeHash(cwd: string): Promise<string> {
	// Hash algorithm-safe empty tree object id.
	return (await runGitOrThrow(["hash-object", "-t", "tree", "--stdin"], { cwd, stdin: "" })).trim()
}

async function tryResolveCommitSha(cwd: string, rev: string): Promise<string | null> {
	try {
		return (await runGitOrThrow(["rev-parse", `${rev}^{commit}`], { cwd })).trim()
	} catch {
		return null
	}
}

function readManifestVersionFromRaw(manifestType: ManifestType, raw: string): string {
	if (manifestType === "npm") return readNpmPackageJsonVersion(raw)
	if (manifestType === "python") return readPyProjectTomlVersion(raw)
	if (manifestType === "rust") return readCargoTomlVersion(raw)
	if (manifestType === "dotnet") return readCsprojVersion(raw)
	throw new Error(`Cannot read manifest version for type: ${manifestType}`)
}

async function inferManifestVersionFromWorktree(params: {
	cwd: string
	manifestType: ManifestType
	manifestRelPath: string
}): Promise<string> {
	const abs = resolvePath(params.cwd, params.manifestRelPath)
	const raw = await readFile(abs, "utf8")
	return readManifestVersionFromRaw(params.manifestType, raw)
}

async function getFirstParent(params: { cwd: string; commitSha: string }): Promise<string | null> {
	const line = (
		await runGitOrThrow(["rev-list", "--parents", "-n", "1", params.commitSha], { cwd: params.cwd })
	).trim()
	const parts = line.split(/\s+/).filter(Boolean)
	// parts[0] is commit, remaining are parents. Use first parent deterministically.
	return parts.length >= 2 ? parts[1]! : null
}

async function readManifestVersionAtCommit(params: {
	cwd: string
	manifestType: ManifestType
	manifestRelPath: string
	commitSha: string
}): Promise<string | null> {
	try {
		const raw = await runGitOrThrow(["show", `${params.commitSha}:${toGitPath(params.manifestRelPath)}`], {
			cwd: params.cwd
		})
		return readManifestVersionFromRaw(params.manifestType, raw)
	} catch {
		return null
	}
}

async function inferBaseCommitFromManifestHistory(params: {
	cwd: string
	manifestType: ManifestType
	manifestRelPath: string
	previousVersion: string
	maxCommitsToScan: number
}): Promise<string | null> {
	// Deterministic scan: walk commits touching the manifest (newest -> oldest) and find
	// the first commit where version == previousVersion and first-parent version != previousVersion.
	const out = await runGitOrThrow(["log", "--format=%H", "--", toGitPath(params.manifestRelPath)], {
		cwd: params.cwd
	})
	const commits = out
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, params.maxCommitsToScan)

	for (const sha of commits) {
		const versionAt = await readManifestVersionAtCommit({
			cwd: params.cwd,
			manifestType: params.manifestType,
			manifestRelPath: params.manifestRelPath,
			commitSha: sha
		})
		if (!versionAt || !semver.eq(versionAt, params.previousVersion)) continue

		const parent = await getFirstParent({ cwd: params.cwd, commitSha: sha })
		if (!parent) return sha

		const parentVersionAt = await readManifestVersionAtCommit({
			cwd: params.cwd,
			manifestType: params.manifestType,
			manifestRelPath: params.manifestRelPath,
			commitSha: parent
		})
		if (!parentVersionAt) return sha
		if (!semver.eq(parentVersionAt, params.previousVersion)) return sha
	}

	return null
}

async function inferPreviousDistinctVersionFromManifestHistory(params: {
	cwd: string
	manifestType: ManifestType
	manifestRelPath: string
	currentVersion: string
	maxCommitsToScan: number
}): Promise<string | null> {
	const out = await runGitOrThrow(["log", "--format=%H", "--", toGitPath(params.manifestRelPath)], {
		cwd: params.cwd
	})
	const commits = out
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, params.maxCommitsToScan)

	for (const sha of commits) {
		const versionAt = await readManifestVersionAtCommit({
			cwd: params.cwd,
			manifestType: params.manifestType,
			manifestRelPath: params.manifestRelPath,
			commitSha: sha
		})
		if (!versionAt) continue
		// Only consider valid semver versions.
		const normalized = semver.valid(versionAt)
		if (!normalized) continue
		if (semver.eq(normalized, params.currentVersion)) continue
		return normalized
	}

	return null
}

export async function resolveVersionBase(params: {
	cwd?: string
	tagPrefix?: string
	manifest?: ManifestTarget
	/** Explicit base git revision (wins for base selection). */
	baseOverride?: string
	/** Explicit previous version (wins for previousVersion selection). */
	previousVersionOverride?: string
	/**
	 * How to infer previousVersion when no version tags exist.
	 * - manifest (default): use the manifest version in the worktree
	 * - manifest-history: use the previous distinct version found in the manifest's git history (falls back to worktree)
	 */
	previousVersionSource?: "manifest" | "manifest-history"
	maxHistoryCommitsToScan?: number
}): Promise<ResolvedVersionBase> {
	const cwd = params.cwd ?? process.cwd()
	const tagPrefix = params.tagPrefix ?? "v"
	const maxCommitsToScan = params.maxHistoryCommitsToScan ?? 500

	// If we are not overriding previousVersion, prefer tags when present.
	const tagResolved = params.previousVersionOverride ? null : await resolveVersionBaseFromGitTags({ cwd, tagPrefix })
	const hasVersionTag = !!tagResolved?.previousTag

	let previousVersion: string
	let previousTag: string | null

	if (params.previousVersionOverride) {
		previousVersion = normalizeSemverOrThrow(params.previousVersionOverride, "--previous-version")
		previousTag = null
	} else if (hasVersionTag) {
		previousVersion = tagResolved!.previousVersion
		previousTag = tagResolved!.previousTag
	} else {
		// No tags: infer from manifest when possible.
		if (!params.manifest) {
			previousVersion = "0.0.0"
			previousTag = null
		} else {
			const manifestType = params.manifest.type
			const manifestRelPath =
				params.manifest.path ?? (manifestType === "dotnet" ? null : defaultManifestPath(manifestType))
			if (manifestType === "go") {
				throw new Error(
					"No version tags found, and Go projects do not declare a publish version in go.mod. Provide --previous-version <semver> (and optionally --base <rev>)."
				)
			}
			if (!manifestRelPath) {
				previousVersion = "0.0.0"
				previousTag = null
			} else {
				const worktreeVersionRaw = await inferManifestVersionFromWorktree({
					cwd,
					manifestType,
					manifestRelPath
				})
				const worktreeVersion = normalizeSemverOrThrow(worktreeVersionRaw, "manifest version")

				if ((params.previousVersionSource ?? "manifest") === "manifest-history") {
					const inferredPrev = await inferPreviousDistinctVersionFromManifestHistory({
						cwd,
						manifestType,
						manifestRelPath,
						currentVersion: worktreeVersion,
						maxCommitsToScan
					})
					previousVersion = inferredPrev ?? worktreeVersion
				} else {
					previousVersion = worktreeVersion
				}
				previousTag = null
			}
		}
	}

	// Base selection precedence: explicit base > tag base (when applicable) > manifest-history > empty-tree.
	if (params.baseOverride) {
		const baseCommit = await tryResolveCommitSha(cwd, params.baseOverride)
		return {
			previousVersion,
			previousTag,
			base: params.baseOverride,
			baseCommit
		}
	}

	if (hasVersionTag && !params.previousVersionOverride) {
		return tagResolved!
	}

	// Try manifest-history base inference when we have a manifest path.
	if (params.manifest && params.manifest.type !== "go") {
		const manifestType = params.manifest.type
		const manifestRelPath =
			params.manifest.path ?? (manifestType === "dotnet" ? null : defaultManifestPath(manifestType))
		if (manifestRelPath) {
			const inferred = await inferBaseCommitFromManifestHistory({
				cwd,
				manifestType,
				manifestRelPath,
				previousVersion,
				maxCommitsToScan
			})
			if (inferred) {
				return { previousVersion, previousTag, base: inferred, baseCommit: inferred }
			}
		}
	}

	const emptyTree = hasVersionTag
		? await getEmptyTreeHash(cwd)
		: tagResolved
			? tagResolved.base
			: await getEmptyTreeHash(cwd)
	return { previousVersion, previousTag, base: emptyTree, baseCommit: null }
}

export async function resolveVersionBaseFromGitTags(params: {
	cwd?: string
	tagPrefix?: string
}): Promise<ResolvedVersionBase> {
	const cwd = params.cwd ?? process.cwd()
	const tagPrefix = params.tagPrefix ?? "v"

	// Only consider tags reachable from HEAD.
	const rawTags = await runGitOrThrow(["tag", "--list", `${tagPrefix}*`, "--merged", "HEAD"], { cwd })
	const tags = rawTags
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean)

	let bestTag: string | null = null
	let bestVersion: string | null = null

	for (const tag of tags) {
		const candidate = stripTagPrefix(tag, tagPrefix)
		const v = semver.valid(candidate)
		if (!v) continue

		if (!bestVersion) {
			bestVersion = v
			bestTag = tag
			continue
		}
		if (semver.gt(v, bestVersion)) {
			bestVersion = v
			bestTag = tag
		}
	}

	if (!bestTag || !bestVersion) {
		// Hash algorithm-safe empty tree object id.
		const emptyTree = (await runGitOrThrow(["hash-object", "-t", "tree", "--stdin"], { cwd, stdin: "" })).trim()
		return { previousVersion: "0.0.0", previousTag: null, base: emptyTree, baseCommit: null }
	}

	const baseCommit = (await runGitOrThrow(["rev-list", "-n", "1", bestTag], { cwd })).trim()
	return { previousVersion: bestVersion, previousTag: bestTag, base: baseCommit, baseCommit }
}

/**
 * Like resolveVersionBaseFromGitTags, but if HEAD is already tagged with a version tag,
 * resolve the *previous* reachable version tag strictly before HEAD.
 *
 * This is useful for generating changelogs/release notes for an already-tagged release:
 * you want the diff to be `previousTag..HEAD`, not `headTag..HEAD` (which would be empty).
 */
export async function resolveVersionBaseBeforeHeadTagFromGitTags(params: {
	cwd?: string
	tagPrefix?: string
}): Promise<ResolvedVersionBase> {
	const cwd = params.cwd ?? process.cwd()
	const tagPrefix = params.tagPrefix ?? "v"

	const head = await resolveHeadVersionTagFromGitTags({ cwd, tagPrefix })
	if (!head.headTag) {
		return await resolveVersionBaseFromGitTags({ cwd, tagPrefix })
	}

	const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd })).trim()

	// Only consider tags reachable from HEAD.
	const rawTags = await runGitOrThrow(["tag", "--list", `${tagPrefix}*`, "--merged", "HEAD"], { cwd })
	const mergedTags = rawTags
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean)

	// Exclude tags that point at HEAD (including annotated tags), then pick the highest semver.
	const candidates: Array<{ tag: string; version: string }> = []
	for (const tag of mergedTags) {
		const candidate = stripTagPrefix(tag, tagPrefix)
		const v = semver.valid(candidate)
		if (!v) continue

		let commitSha: string
		try {
			commitSha = (await runGitOrThrow(["rev-list", "-n", "1", tag], { cwd })).trim()
		} catch {
			continue
		}
		if (commitSha === headSha) continue
		candidates.push({ tag, version: v })
	}

	if (!candidates.length) {
		// Hash algorithm-safe empty tree object id.
		const emptyTree = (await runGitOrThrow(["hash-object", "-t", "tree", "--stdin"], { cwd, stdin: "" })).trim()
		return { previousVersion: "0.0.0", previousTag: null, base: emptyTree, baseCommit: null }
	}

	// Pick highest version deterministically.
	let best = candidates[0]
	for (const c of candidates.slice(1)) {
		if (semver.gt(c.version, best.version)) best = c
	}

	const baseCommit = (await runGitOrThrow(["rev-list", "-n", "1", best.tag], { cwd })).trim()
	return { previousVersion: best.version, previousTag: best.tag, base: baseCommit, baseCommit }
}

export async function resolveHeadVersionTagFromGitTags(params: {
	cwd?: string
	tagPrefix?: string
}): Promise<ResolvedHeadVersionTag> {
	const cwd = params.cwd ?? process.cwd()
	const tagPrefix = params.tagPrefix ?? "v"

	// Resolve tags pointing at HEAD, including annotated tags.
	// NOTE: `git tag --points-at` can miss annotated tags (they point to tag objects),
	// and `for-each-ref %(peeled)` isn't available in older git builds. Use a portable approach:
	// list version tags and resolve each tag to its commit via `rev-list`.
	const headSha = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd })).trim()
	const rawTags = await runGitOrThrow(["tag", "--list", `${tagPrefix}*`], { cwd })
	const allTags = rawTags
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean)

	const tags: string[] = []
	for (const tag of allTags) {
		let commitSha: string
		try {
			commitSha = (await runGitOrThrow(["rev-list", "-n", "1", tag], { cwd })).trim()
		} catch {
			continue
		}
		if (commitSha === headSha) tags.push(tag)
	}

	let bestTag: string | null = null
	let bestVersion: string | null = null

	for (const tag of tags) {
		const candidate = stripTagPrefix(tag, tagPrefix)
		const v = semver.valid(candidate)
		if (!v) continue

		if (!bestVersion) {
			bestVersion = v
			bestTag = tag
			continue
		}
		if (semver.gt(v, bestVersion)) {
			bestVersion = v
			bestTag = tag
		}
	}

	return { headTag: bestTag, headVersion: bestVersion }
}
