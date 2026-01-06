import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { compareStrings } from "../src/util/compare"
import { getDiffHunks, getDiffSummary } from "../src"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import {
	azureChatCompletion,
	formatEvidenceIndex,
	formatHunks,
	getAzureConfigForEval,
	isTruthyEnv,
	parseEvalJson
} from "./llmEvalHelpers"

describe("Integration: semantic acceptance (local Azure eval)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_EVAL === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"LLM accepts the generated changelog as accurate",
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

			const generated = await runChangelogPipeline({
				base,
				cwd: dir,
				llmClient: makeDeterministicTestLLMClient()
			})
			const diffSummary = await getDiffSummary(base, { cwd: dir })

			const hunkIds = Object.values(generated.model.evidence)
				.flatMap((e) => e.hunkIds)
				.filter(Boolean)
				.sort(compareStrings)

			const hunks = await getDiffHunks({ base, cwd: dir, hunkIds, maxTotalBytes: 64 * 1024 })

			const system = [
				"You are a strict evaluator for a changelog generator.",
				"You must judge correctness ONLY from the evidence provided.",
				"Output MUST be valid JSON only (no prose, no markdown), matching this schema:",
				'{ "accepted": boolean, "reason": string | null }',
				"Acceptance criteria:",
				"- The changelog must not claim changes not supported by evidence.",
				"- The changelog must cover the main user-visible changes from the evidence.",
				"- Minor wording differences are OK if the meaning is correct.",
				"If not accepted, provide a short reason describing what is wrong or missing."
			].join("\n")

			const user = [
				"Evaluate the changelog for the diff base..HEAD.",
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
				formatEvidenceIndex(generated.model.evidence),
				"",
				"BOUNDED HUNKS:",
				formatHunks(hunks),
				"",
				"GENERATED CHANGELOG MARKDOWN:",
				generated.markdown
			].join("\n")

			const content = await azureChatCompletion(azure.cfg, [
				{ role: "system", content: system },
				{ role: "user", content: user }
			])

			const verdict = parseEvalJson(content)
			expect(verdict.accepted, verdict.reason ?? "LLM rejected changelog").toBe(true)
		},
		300_000
	)
})
