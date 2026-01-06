import type { LLMClient } from "../llm/types"
import { getCurrentBranch, pushBranchAndTag, createReleaseCommit, createAnnotatedTag, tagExists } from "../git/release"
import { runNpmOrThrow } from "../npm/runNpm"
import type { ManifestType } from "../version/manifests"
import { runCargoOrThrow } from "../rust/runCargo"
import { runPythonOrThrow } from "../python/runPython"
import { readFile } from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { dirname, resolve } from "node:path"
import { runDotnetOrThrow } from "../dotnet/runDotnet"
import { runGitOrThrow } from "../git/runGit"

async function listDotnetPackages(params: { cwd: string; projectPath: string }): Promise<string[]> {
	const projectAbs = resolve(params.cwd, params.projectPath)
	const projectDir = dirname(projectAbs)
	const outDir = join(projectDir, "bin", "Release")

	const entries = await readdir(outDir, { withFileTypes: true })
	const pkgs = entries
		.filter((e) => e.isFile())
		.map((e) => e.name)
		.filter((n) => n.endsWith(".nupkg") && !n.endsWith(".snupkg"))
		.sort((a, b) => a.localeCompare(b))
		.map((n) => join(outDir, n))

	if (!pkgs.length) {
		throw new Error(`No .nupkg files found under ${outDir}`)
	}
	return pkgs
}

async function listPythonDistArtifacts(cwd: string): Promise<string[]> {
	const distDir = join(cwd, "dist")
	const entries = await readdir(distDir, { withFileTypes: true })
	const files = entries
		.filter((e) => e.isFile())
		.map((e) => e.name)
		.filter((n) => n.endsWith(".whl") || n.endsWith(".tar.gz"))
		.sort((a, b) => a.localeCompare(b))
		.map((n) => join("dist", n))

	if (!files.length) {
		throw new Error("No Python build artifacts found in dist/. Expected .whl or .tar.gz")
	}
	return files
}

export type PublishRunner = (params: { cwd: string }) => Promise<void>

async function defaultPublishRunner(params: {
	cwd: string
	projectType: ManifestType
	manifestPath?: string
}): Promise<void> {
	if (params.projectType === "npm") {
		await runNpmOrThrow(["publish"], { cwd: params.cwd })
		return
	}
	if (params.projectType === "dotnet") {
		const projectPath = params.manifestPath
		if (!projectPath) {
			throw new Error("dotnet postpublish requires --manifest <path/to.csproj>")
		}

		const source =
			process.env.AI_PUBLISH_NUGET_SOURCE ?? process.env.NUGET_SOURCE ?? "https://api.nuget.org/v3/index.json"
		const apiKey = process.env.AI_PUBLISH_NUGET_API_KEY ?? process.env.NUGET_API_KEY
		if (!apiKey) {
			throw new Error(
				"Missing NuGet API key. Set AI_PUBLISH_NUGET_API_KEY (or NUGET_API_KEY) before running dotnet postpublish."
			)
		}

		// User is expected to build/pack before calling postpublish.
		// We only push already-produced .nupkg files from the conventional bin/Release output.
		const pkgs = await listDotnetPackages({ cwd: params.cwd, projectPath })
		for (const pkgAbs of pkgs) {
			await runDotnetOrThrow(
				["nuget", "push", pkgAbs, "--source", source, "--api-key", apiKey, "--skip-duplicate"],
				{
					cwd: params.cwd
				}
			)
		}
		return
	}
	if (params.projectType === "rust") {
		await runCargoOrThrow(["publish"], { cwd: params.cwd })
		return
	}
	if (params.projectType === "go") {
		// Go modules are effectively “published” by pushing the release tag.
		return
	}
	if (params.projectType === "python") {
		// User is expected to build before calling postpublish (dist/* must exist).
		const artifacts = await listPythonDistArtifacts(params.cwd)
		await runPythonOrThrow(["-m", "twine", "upload", ...artifacts], { cwd: params.cwd })
		return
	}
	throw new Error(
		`postpublish does not have a built-in publish step for project type: ${params.projectType}. ` +
			"Either publish manually, or call runPostpublishPipeline({ publishRunner }) programmatically."
	)
}

export async function runPostpublishPipeline(params: {
	cwd?: string
	remote?: string
	projectType?: ManifestType
	manifestPath?: string
	/** Present only for CLI parity; not used by postpublish. */
	llmClient?: LLMClient
	publishRunner?: PublishRunner
}): Promise<{ tag: string; branch: string; remote: string }> {
	const cwd = params.cwd ?? process.cwd()
	const remote = params.remote ?? "origin"
	const projectType: ManifestType = params.projectType ?? "npm"
	const branch = await getCurrentBranch({ cwd })

	// Prepublish writes a small intent file (ignored by git) so postpublish can
	// create the release commit + tag *after* publish succeeds.
	const intentPath = resolve(cwd, ".ai-publish", "prepublish.json")
	let intentRaw: string
	try {
		intentRaw = await readFile(intentPath, "utf8")
	} catch {
		throw new Error("Missing .ai-publish/prepublish.json. Run prepublish first.")
	}

	const intent = JSON.parse(intentRaw) as {
		predictedTag: string
		pathsToCommit: string[]
		commitMessage: string
		tagMessage: string
		manifestType: ManifestType
		manifestPath: string
	}

	if (!intent.predictedTag || !/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(intent.predictedTag)) {
		throw new Error("Invalid prepublish intent: predictedTag")
	}
	if (!Array.isArray(intent.pathsToCommit) || intent.pathsToCommit.length === 0) {
		throw new Error("Invalid prepublish intent: pathsToCommit")
	}
	if (!intent.commitMessage || !intent.tagMessage) {
		throw new Error("Invalid prepublish intent: commitMessage/tagMessage")
	}

	if (await tagExists({ cwd, tag: intent.predictedTag })) {
		throw new Error(`Tag already exists: ${intent.predictedTag}`)
	}

	// Safety: refuse to run if there are local changes outside the release paths.
	// IMPORTANT: do not use .trim() here; it can remove the leading space from the
	// first porcelain line (e.g. " M package.json"), which breaks path parsing.
	const status = (await runGitOrThrow(["status", "--porcelain"], { cwd })).trimEnd()
	if (status.trim().length > 0) {
		const allowed = new Set(intent.pathsToCommit.map((p) => p.replace(/\\/g, "/")))
		const isAllowedPath = (path: string): boolean => {
			if (allowed.has(path)) return true
			// `git status --porcelain` may report untracked directories as `dir/`.
			// Treat that as allowed if any explicitly allowed file lives under it.
			if (path.endsWith("/")) {
				for (const a of allowed) {
					if (a.startsWith(path)) return true
				}
				return false
			}
			// Also allow if the intent explicitly allows a directory prefix.
			for (const a of allowed) {
				if (a.endsWith("/") && path.startsWith(a)) return true
			}
			return false
		}
		const changedPaths = status
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				// Porcelain: XY <path> or XY <old> -> <new>
				// Important: do NOT trim leading whitespace; it is part of the XY columns.
				const withoutStatus = line.slice(3)
				const arrow = withoutStatus.lastIndexOf("->")
				const path = arrow >= 0 ? withoutStatus.slice(arrow + 2).trim() : withoutStatus.trim()
				return path.replace(/\\/g, "/")
			})

		const unexpected = changedPaths.filter((p) => !isAllowedPath(p))
		if (unexpected.length) {
			throw new Error(
				"Working tree contains changes outside release outputs. " +
					"Commit/stash them before postpublish. Unexpected: " +
					unexpected.sort().join(", ")
			)
		}
	}

	const publish =
		params.publishRunner ??
		((p: { cwd: string }) => defaultPublishRunner({ ...p, projectType, manifestPath: params.manifestPath }))
	await publish({ cwd })

	// Publish succeeded. Now create release commit + annotated tag, then push.
	const { commitSha } = await createReleaseCommit({ cwd, paths: intent.pathsToCommit, message: intent.commitMessage })
	await createAnnotatedTag({ cwd, tag: intent.predictedTag, message: intent.tagMessage })

	// Sanity: tag should point at the new commit.
	const tagTarget = (await runGitOrThrow(["rev-list", "-n", "1", intent.predictedTag], { cwd })).trim()
	if (tagTarget !== commitSha) {
		throw new Error(`Internal error: created tag ${intent.predictedTag} does not point at release commit`)
	}

	await pushBranchAndTag({ cwd, remote, branch, tag: intent.predictedTag })
	return { tag: intent.predictedTag, branch, remote }
}
