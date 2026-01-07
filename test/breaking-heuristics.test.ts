import { describe, expect, test } from "vitest"
import { commitChange, makeTempGitRepo } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { indexDiff } from "../src/diff"
import { buildEvidenceFromManifest } from "../src/changelog/evidence"
import { detectBreakingChanges } from "../src/changelog/breaking"
import { readFile } from "node:fs/promises"
import type { DiffIndexManifest } from "../src/diff/types"

describe("breaking change heuristics", () => {
	test("detects package.json major version bump as breaking", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2) + "\n",
			"add package.json"
		)
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(
			dir,
			"package.json",
			JSON.stringify({ name: "demo", version: "2.0.0" }, null, 2) + "\n",
			"bump major"
		)

		const idx = await indexDiff({ base, cwd: dir })
		const manifest = JSON.parse(await readFile(idx.manifestPath, "utf8")) as DiffIndexManifest
		const evidence = buildEvidenceFromManifest(manifest)
		const bullets = await detectBreakingChanges({ base, cwd: dir, evidence })
		expect(bullets.some((b) => /bumped package major version/i.test(b.text))).toBe(true)
	})

	test("detects Cargo.toml major version bump as breaking", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(
			dir,
			"Cargo.toml",
			["[package]", 'name = "demo"', 'version = "0.9.0"', ""].join("\n"),
			"add Cargo.toml"
		)
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(
			dir,
			"Cargo.toml",
			["[package]", 'name = "demo"', 'version = "1.0.0"', ""].join("\n"),
			"bump major"
		)

		const idx = await indexDiff({ base, cwd: dir })
		const manifest = JSON.parse(await readFile(idx.manifestPath, "utf8")) as DiffIndexManifest
		const evidence = buildEvidenceFromManifest(manifest)
		const bullets = await detectBreakingChanges({ base, cwd: dir, evidence })
		expect(bullets.some((b) => /Cargo\.toml/i.test(b.text) && /bumped package major version/i.test(b.text))).toBe(
			true
		)
	})

	test("detects breaking TS type change when internal type is re-exported", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(
			dir,
			"src/index.ts",
			[
				"// Public entrypoint",
				"export { configure } from './internal/configure'",
				"export type { ConfigureOptions } from './internal/configure'",
				""
			].join("\n"),
			"add public entrypoint"
		)
		await commitChange(
			dir,
			"src/internal/configure.ts",
			[
				"export type ConfigureOptions = { timeoutMs?: number }",
				"export function configure(_opts: ConfigureOptions): void { /* noop */ }",
				""
			].join("\n"),
			"add internal configure"
		)
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await commitChange(
			dir,
			"src/internal/configure.ts",
			[
				"export type ConfigureOptions = { timeoutMs: number }",
				"export function configure(_opts: ConfigureOptions): void { /* noop */ }",
				""
			].join("\n"),
			"make timeoutMs required"
		)

		const idx = await indexDiff({ base, cwd: dir })
		const manifest = JSON.parse(await readFile(idx.manifestPath, "utf8")) as DiffIndexManifest
		const evidence = buildEvidenceFromManifest(manifest)
		const bullets = await detectBreakingChanges({ base, cwd: dir, evidence })
		expect(bullets.some((b) => /ConfigureOptions/i.test(b.text) && /timeoutMs/i.test(b.text))).toBe(true)
	}, 60_000)
})
