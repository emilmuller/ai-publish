import semver from "semver"
import { runGitOrThrow } from "../git/runGit"

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
