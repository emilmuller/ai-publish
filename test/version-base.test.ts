import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import {
	resolveHeadVersionTagFromGitTags,
	resolveVersionBase,
	resolveVersionBaseBeforeHeadTagFromGitTags,
	resolveVersionBaseFromGitTags
} from "../src/version/resolveVersionBase"

describe("Version base resolution", () => {
	test("defaults to 0.0.0 and empty-tree base when no version tags exist", async () => {
		const { dir } = await makeTempGitRepo()
		const res = await resolveVersionBaseFromGitTags({ cwd: dir })
		expect(res.previousVersion).toBe("0.0.0")
		expect(res.previousTag).toBeNull()
		expect(res.baseCommit).toBeNull()
		expect(res.base).toMatch(/^[0-9a-f]{40,64}$/i)
	})

	test("selects the highest reachable v<semver> tag (including prereleases)", async () => {
		const { dir } = await makeTempGitRepo()

		// Tag an earlier commit.
		const v100Commit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.0.0", v100Commit], { cwd: dir })

		await commitChange(dir, "x.txt", "x1\n", "change x")
		const v120b1Commit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.2.0-beta.1", v120b1Commit], { cwd: dir })

		await commitChange(dir, "y.txt", "y1\n", "change y")

		const res = await resolveVersionBaseFromGitTags({ cwd: dir })
		expect(res.previousTag).toBe("v1.2.0-beta.1")
		expect(res.previousVersion).toBe("1.2.0-beta.1")
		const tagCommit = (await runGitOrThrow(["rev-list", "-n", "1", "v1.2.0-beta.1"], { cwd: dir })).trim()
		expect(res.base).toBe(tagCommit)
		expect(res.baseCommit).toBe(tagCommit)
	}, 60_000)

	test("resolves a version tag pointing at HEAD (including annotated tags)", async () => {
		const { dir } = await makeTempGitRepo()

		// Lightweight tag at HEAD.
		const head0 = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v0.1.0", head0], { cwd: dir })

		// Annotated tag at HEAD.
		await runGitOrThrow(["tag", "-a", "v0.2.0", "-m", "annotated", head0], { cwd: dir })

		const res0 = await resolveHeadVersionTagFromGitTags({ cwd: dir })
		expect(res0.headTag).toBe("v0.2.0")
		expect(res0.headVersion).toBe("0.2.0")

		// Move HEAD and add a new annotated tag there.
		await commitChange(dir, "z.txt", "z1\n", "change z")
		const head1 = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "-a", "v1.0.0", "-m", "release", head1], { cwd: dir })

		const res1 = await resolveHeadVersionTagFromGitTags({ cwd: dir })
		expect(res1.headTag).toBe("v1.0.0")
		expect(res1.headVersion).toBe("1.0.0")
	}, 60_000)

	test("base-before-head-tag resolves the previous tag (not the tag at HEAD)", async () => {
		const { dir } = await makeTempGitRepo()

		// Tag v1.0.0 at the initial commit.
		const c0 = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.0.0", c0], { cwd: dir })

		// Move HEAD and tag v1.1.0 there.
		await commitChange(dir, "x.txt", "x1\n", "change x")
		const c1 = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.1.0", c1], { cwd: dir })

		const head = await resolveHeadVersionTagFromGitTags({ cwd: dir })
		expect(head.headTag).toBe("v1.1.0")

		const base = await resolveVersionBaseBeforeHeadTagFromGitTags({ cwd: dir })
		expect(base.previousTag).toBe("v1.0.0")
		const v100Commit = (await runGitOrThrow(["rev-list", "-n", "1", "v1.0.0"], { cwd: dir })).trim()
		expect(base.base).toBe(v100Commit)
		expect(base.baseCommit).toBe(v100Commit)
	}, 120_000)

	test("base-before-head-tag falls back to empty tree when only HEAD is tagged", async () => {
		const { dir } = await makeTempGitRepo()
		const c0 = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
		await runGitOrThrow(["tag", "v1.0.0", c0], { cwd: dir })

		const base = await resolveVersionBaseBeforeHeadTagFromGitTags({ cwd: dir })
		expect(base.previousTag).toBeNull()
		expect(base.previousVersion).toBe("0.0.0")
		expect(base.baseCommit).toBeNull()
	}, 60_000)

	test("no tags + manifest already bumped: can infer previousVersion from manifest history", async () => {
		const { dir } = await makeTempGitRepo()

		const v123Commit = await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.3" }, null, 2) + "\n",
			"set version 1.2.3"
		)
		const v124Commit = await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "pkg", version: "1.2.4" }, null, 2) + "\n",
			"bump version 1.2.4"
		)

		// Default behavior: previousVersion is inferred from the worktree manifest (1.2.4)
		// and base resolves to the commit where version became 1.2.4.
		const worktree = await resolveVersionBase({
			cwd: dir,
			manifest: { type: "npm", path: "package.json", write: false }
		})
		expect(worktree.previousTag).toBeNull()
		expect(worktree.previousVersion).toBe("1.2.4")
		expect(worktree.base).toBe(v124Commit)

		// History-based behavior: infer previousVersion as the previous distinct version (1.2.3)
		// and base resolves to the commit where version became 1.2.3.
		const hist = await resolveVersionBase({
			cwd: dir,
			manifest: { type: "npm", path: "package.json", write: false },
			previousVersionSource: "manifest-history"
		})
		expect(hist.previousTag).toBeNull()
		expect(hist.previousVersion).toBe("1.2.3")
		expect(hist.base).toBe(v123Commit)
	}, 60_000)
})
