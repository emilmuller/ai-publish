import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runReleaseNotesPipeline } from "../src/pipeline/runReleaseNotesPipeline"
import { compareStrings } from "../src/util/compare"
import { getDiffHunks, getDiffSummary, indexDiff, buildEvidenceFromManifest } from "../src"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { DiffIndexManifest } from "../src/diff/types"
import {
	azureChatCompletion,
	formatEvidenceIndex,
	formatHunks,
	getAzureConfigForEval,
	isTruthyEnv,
	parseEvalJson
} from "./llmEvalHelpers"

describe("Integration: semantic acceptance for release notes (local Azure eval)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_EVAL === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"LLM accepts the generated release notes as accurate",
		async () => {
			const azure = getAzureConfigForEval()
			if (!azure.ok) {
				throw new Error(`AI_PUBLISH_LLM_EVAL=1 but Azure config missing: ${azure.missing.join(", ")}`)
			}

			const { dir } = await makeTempGitRepo()
			await commitChange(dir, "config.yml", "name: base\n", "add config base")
			await commitChange(dir, "old.txt", "to be removed\n", "add old file")

			const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

			await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })
			await commitChange(dir, "config.yml", "name: changed\n", "change config")
			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			const generated = await runReleaseNotesPipeline({
				base,
				cwd: dir,
				llmClient: makeDeterministicTestLLMClient()
			})
			const diffSummary = await getDiffSummary(base, { cwd: dir })

			// Rebuild evidence from the authoritative diff index for evaluation context.
			const indexRes = await indexDiff({ base, cwd: dir })
			const manifestPath = join(indexRes.indexDir, "manifest.json")
			const manifestText = await readFile(manifestPath, "utf8")
			const manifest = JSON.parse(manifestText) as DiffIndexManifest
			const evidence = buildEvidenceFromManifest(manifest)

			const hunkIds = Object.values(evidence)
				.flatMap((e) => e.hunkIds)
				.filter(Boolean)
				.sort(compareStrings)

			const hunks = await getDiffHunks({ base, cwd: dir, hunkIds, maxTotalBytes: 64 * 1024 })

			const system = [
				"You are a strict evaluator for a release-notes generator.",
				"You must judge correctness ONLY from the evidence provided.",
				"Output MUST be valid JSON only (no prose, no markdown), matching this schema:",
				'{ "accepted": boolean, "reason": string | null }',
				"Acceptance criteria:",
				"- The release notes must not claim changes not supported by evidence.",
				"- The release notes should cover the main user-visible changes from the evidence.",
				"- Minor wording differences are OK if the meaning is correct.",
				"If not accepted, provide a short reason describing what is wrong or missing."
			].join("\n")

			const user = [
				"Evaluate the release notes for the diff base..HEAD.",
				"",
				"DIFF SUMMARY:",
				`base: ${diffSummary.baseSha}`,
				`head: ${diffSummary.headSha}`,
				...diffSummary.files.map((f) => {
					return `- ${f.changeType.toUpperCase()} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${
						f.isBinary ? " (binary)" : ""
					}`
				}),
				"",
				"EVIDENCE INDEX (metadata only):",
				formatEvidenceIndex(evidence),
				"",
				"BOUNDED HUNKS:",
				formatHunks(hunks),
				"",
				"GENERATED RELEASE NOTES MARKDOWN:",
				generated.markdown
			].join("\n")

			if (process.env.AI_PUBLISH_LLM_EVAL_PRINT === "1") {
				// eslint-disable-next-line no-console
				console.log("\n--- RELEASE NOTES MARKDOWN ---\n" + generated.markdown + "\n")
			}

			const content = await azureChatCompletion(azure.cfg, [
				{ role: "system", content: system },
				{ role: "user", content: user }
			])

			const verdict = parseEvalJson(content)
			expect(verdict.accepted, verdict.reason ?? "LLM rejected release notes").toBe(true)
		},
		120_000
	)
})
