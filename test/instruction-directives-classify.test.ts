import { describe, expect, test } from "vitest"
import { commitChange, makeTempGitRepo } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { indexDiff } from "../src/diff"
import { getResolvedInstructions } from "../src/instructions/resolveInstructions"
import { buildEvidenceFromManifest } from "../src/changelog/evidence"
import { readFile } from "node:fs/promises"
import type { DiffIndexManifest } from "../src/diff/types"

describe("instruction directives", () => {
	test("ai-publish.publicPathPrefixes can mark internal paths as public-api", async () => {
		const { dir } = await makeTempGitRepo()

		// Repo-level instructions.
		await commitChange(
			dir,
			"AGENTS.md",
			["# Repo instructions", "ai-publish.publicPathPrefixes: src/internal"].join("\n") + "\n",
			"add public path override"
		)

		await commitChange(dir, "src/internal/thing.ts", "export const x = 1\n", "add internal file")
		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		// Change an internal file; by default it would be surface=internal.
		await commitChange(dir, "src/internal/thing.ts", "export const x = 2\n", "modify internal file")

		const idx = await indexDiff({ base, cwd: dir })
		const resolved = await getResolvedInstructions({ cwd: dir, paths: idx.summary.files.map((f) => f.path) })
		const instructionsByPath = Object.fromEntries(resolved.map((r) => [r.targetPath, r]))
		const manifest = JSON.parse(await readFile(idx.manifestPath, "utf8")) as DiffIndexManifest
		const evidence = buildEvidenceFromManifest(manifest, { instructionsByPath })

		const node = Object.values(evidence).find((e) => e.filePath === "src/internal/thing.ts")
		expect(node, "Expected evidence node for modified internal file").toBeTruthy()
		expect(node!.surface).toBe("public-api")
	})
})
