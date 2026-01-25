import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import type { LLMClient } from "../src/llm/types"

describe("Integration: release notes generation (network-free)", () => {
	test("generates stable markdown for add/modify/delete", async () => {
		const { dir } = await makeTempGitRepo()

		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		await commitChange(dir, "old.txt", "to be removed\n", "add old file")

		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
		await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })

		await commitChange(dir, "config.yml", "name: changed\n", "change config")
		await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

		const res = await runReleaseNotesPipeline({ base, cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		expect(res.markdown).toContain("## Unreleased\n")
		expect(res.markdown).toContain("### Highlights")
		expect(res.markdown).toContain("- Expose foo in public API")
		expect(res.markdown).toContain("- Update name from 'base' to 'changed'")
	}, 60_000)

	test("allows empty release notes markdown", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")
		const base = (await runGitOrThrow(["rev-parse", "HEAD~1"], { cwd: dir })).trim()

		const stub: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic() {
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added foo", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes() {
				return { markdown: "", evidenceNodeIds: [] }
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		const res = await runReleaseNotesPipeline({ base, cwd: dir, llmClient: stub })
		expect(res.releaseNotes.markdown).toBe("")
		expect(res.releaseNotes.evidenceNodeIds).toEqual([])
		expect(res.markdown).toBe("## Unreleased\n")
	})

	test("rejects Breaking Changes without Upgrade Guide (Developers)", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")
		const base = (await runGitOrThrow(["rev-parse", "HEAD~1"], { cwd: dir })).trim()

		const stub: LLMClient = {
			async pass1Mechanical() {
				return { notes: [] }
			},
			async pass2Semantic() {
				return { notes: [] }
			},
			async pass3Editorial(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					breakingChanges: [],
					added: [{ text: "Added foo", evidenceNodeIds: [firstEvidenceId] }],
					changed: [],
					fixed: [],
					removed: [],
					internalTooling: [],
					evidence: {}
				}
			},
			async pass3ReleaseNotes(input) {
				const firstEvidenceId = Object.keys(input.evidence).sort()[0]
				if (!firstEvidenceId) throw new Error("no evidence")
				return {
					markdown: [
						"This release includes breaking changes.",
						"",
						"### Breaking Changes",
						"- **Action required:** Update your integration.",
						""
					].join("\n"),
					evidenceNodeIds: [firstEvidenceId]
				}
			},
			async pass3VersionBump(input) {
				return { nextVersion: input.nextVersion, justification: "ok" }
			}
		}

		await expect(runReleaseNotesPipeline({ base, cwd: dir, llmClient: stub })).rejects.toThrow(
			/Breaking Changes.*Upgrade Guide \(Developers\)/
		)
	}, 60_000)
})
