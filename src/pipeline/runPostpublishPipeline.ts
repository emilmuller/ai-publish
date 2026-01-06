import type { LLMClient } from "../llm/types"
import { resolveHeadVersionTagFromGitTags } from "../version/resolveVersionBase"
import { assertCleanWorktree, getCurrentBranch, getHeadSha, getTagTargetSha, pushBranchAndTag } from "../git/release"
import { runNpmOrThrow } from "../npm/runNpm"
import type { ManifestType } from "../version/manifests"
import { runCargoOrThrow } from "../rust/runCargo"
import { runPythonOrThrow } from "../python/runPython"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { dirname, resolve } from "node:path"
import { runDotnetOrThrow } from "../dotnet/runDotnet"

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

		// Pack to a deterministic location (default bin/Release). We keep it minimal: Release config + CI build.
		await runDotnetOrThrow(["pack", projectPath, "-c", "Release", "-p:ContinuousIntegrationBuild=true"], {
			cwd: params.cwd
		})

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
		// Standard Python publishing flow (PyPI-like):
		// 1) build: produces dist/*
		// 2) upload: twine uploads the built artifacts
		await runPythonOrThrow(["-m", "build"], { cwd: params.cwd })
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

	await assertCleanWorktree({ cwd })
	const branch = await getCurrentBranch({ cwd })

	const head = await resolveHeadVersionTagFromGitTags({ cwd })
	if (!head.headTag) {
		throw new Error("HEAD is not tagged with a version tag. Run prepublish first.")
	}

	const headSha = await getHeadSha({ cwd })
	const tagTarget = await getTagTargetSha({ cwd, tag: head.headTag })
	if (tagTarget !== headSha) {
		throw new Error(`Version tag ${head.headTag} does not point at HEAD. Refusing to publish/push.`)
	}

	const publish =
		params.publishRunner ??
		((p: { cwd: string }) => defaultPublishRunner({ ...p, projectType, manifestPath: params.manifestPath }))
	await publish({ cwd })

	await pushBranchAndTag({ cwd, remote, branch, tag: head.headTag })
	return { tag: head.headTag, branch, remote }
}
