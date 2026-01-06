import { runGitCapture, runGitOrThrow } from "./runGit"

export async function assertCleanWorktree(params: { cwd?: string }): Promise<void> {
	const cwd = params.cwd
	const out = await runGitOrThrow(["status", "--porcelain"], { cwd })
	if (out.trim()) {
		throw new Error("Working tree is not clean. Commit/stash changes before running this command.")
	}
}

export async function getCurrentBranch(params: { cwd?: string }): Promise<string> {
	const { stdout, stderr, exitCode } = await runGitCapture(["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: params.cwd
	})
	if (exitCode !== 0) {
		const suffix = stderr.trim() ? `\n${stderr.trim()}` : ""
		throw new Error(`Not on a branch (detached HEAD).${suffix}`)
	}
	const branch = stdout.trim()
	if (!branch) throw new Error("Not on a branch (detached HEAD).")
	return branch
}

export async function getHeadSha(params: { cwd?: string }): Promise<string> {
	return (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: params.cwd })).trim()
}

export async function tagExists(params: { cwd?: string; tag: string }): Promise<boolean> {
	const res = await runGitCapture(["rev-parse", "-q", "--verify", `refs/tags/${params.tag}`], { cwd: params.cwd })
	return res.exitCode === 0
}

export async function getTagTargetSha(params: { cwd?: string; tag: string }): Promise<string> {
	// Works for both lightweight and annotated tags.
	return (await runGitOrThrow(["rev-list", "-n", "1", params.tag], { cwd: params.cwd })).trim()
}

export async function createReleaseCommit(params: {
	cwd?: string
	paths: string[]
	message: string
}): Promise<{ commitSha: string }> {
	if (!params.paths.length) {
		throw new Error("No paths provided to commit.")
	}
	await runGitOrThrow(["add", "--", ...params.paths], { cwd: params.cwd })
	await runGitOrThrow(["commit", "-m", params.message], { cwd: params.cwd })
	return { commitSha: await getHeadSha({ cwd: params.cwd }) }
}

export async function createAnnotatedTag(params: { cwd?: string; tag: string; message: string }): Promise<void> {
	await runGitOrThrow(["tag", "-a", params.tag, "-m", params.message], { cwd: params.cwd })
}

export async function pushBranchAndTag(params: {
	cwd?: string
	remote: string
	branch: string
	tag: string
}): Promise<void> {
	await runGitOrThrow(["push", params.remote, params.branch], { cwd: params.cwd })
	await runGitOrThrow(["push", params.remote, params.tag], { cwd: params.cwd })
}
