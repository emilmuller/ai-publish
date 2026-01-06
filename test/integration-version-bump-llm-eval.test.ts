import { describe, expect, test } from "vitest"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { runVersionBumpPipeline } from "../src/pipeline/runVersionBumpPipeline"
import { resolveVersionBaseFromGitTags } from "../src/version/resolveVersionBase"
import { azureChatCompletion, getAzureConfigForEval, isTruthyEnv, parseEvalJson } from "./llmEvalHelpers"

function summarizeModel(model: any): string {
	function section(name: string, arr: any[]): string {
		const bullets = (arr ?? []).slice(0, 20).map((b) => `- ${String(b.text ?? "").trim()}`)
		return [`${name} (${(arr ?? []).length})`, ...bullets].join("\n")
	}
	return [
		section("breakingChanges", model.breakingChanges),
		"",
		section("added", model.added),
		"",
		section("changed", model.changed),
		"",
		section("fixed", model.fixed),
		"",
		section("removed", model.removed),
		"",
		section("internalTooling", model.internalTooling)
	].join("\n")
}

describe("Integration: version bump semantic acceptance (local Azure eval)", () => {
	const isCi = isTruthyEnv(process.env.CI)
	const requested = process.env.AI_PUBLISH_LLM_EVAL === "1" && !isCi
	const t = requested ? test : test.skip

	t(
		"LLM accepts computed bumpType and nextVersion as consistent with changelog model",
		async () => {
			const azure = getAzureConfigForEval()
			if (!azure.ok) {
				throw new Error(`AI_PUBLISH_LLM_EVAL=1 but Azure config missing: ${azure.missing.join(", ")}`)
			}

			const { dir } = await makeTempGitRepo()
			await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }, null, 2) + "\n")
			await runGitOrThrow(["add", "package.json"], { cwd: dir })
			await runGitOrThrow(["commit", "-m", "add package"], { cwd: dir })

			const tagCommit = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()
			await runGitOrThrow(["tag", "v1.2.3-beta.1", tagCommit], { cwd: dir })

			await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

			const deterministic = makeDeterministicTestLLMClient()
			const resolved = await resolveVersionBaseFromGitTags({ cwd: dir })
			const changelog = await runChangelogPipeline({ base: resolved.base, cwd: dir, llmClient: deterministic })
			const bumped = await runVersionBumpPipeline({ cwd: dir, llmClient: deterministic })

			const system = [
				"You are a strict evaluator for a semver version-bump decision.",
				"Judge correctness ONLY from the provided changelog model summary and the stated rules.",
				"Output MUST be valid JSON only (no prose, no markdown), matching this schema:",
				'{ "accepted": boolean, "reason": string | null }',
				"Rules:",
				"- bumpType must be: major if breakingChanges non-empty; else minor if added non-empty; else patch if any of changed/fixed/removed non-empty; else none.",
				"- If bumpType is none, nextVersion must equal previousVersion.",
				"- If bumpType is not none, nextVersion must be > previousVersion.",
				"- If previousVersion is a prerelease:",
				"  - patch bumps increment the prerelease counter on the same base (e.g., 1.2.3-beta.1 -> 1.2.3-beta.2).",
				"  - minor bumps follow semver preminor semantics (e.g., 1.2.3-beta.1 -> 1.3.0-beta.0).",
				"  - major bumps follow semver premajor semantics (e.g., 1.2.3-beta.1 -> 2.0.0-beta.0).",
				"If not accepted, provide a short reason."
			].join("\n")

			const user = [
				"Evaluate this version bump output:",
				`previousVersion: ${bumped.previousVersion}`,
				`bumpType: ${bumped.bumpType}`,
				`nextVersion: ${bumped.nextVersion}`,
				"",
				"CHANGELOG MODEL SUMMARY:",
				summarizeModel(changelog.model),
				"",
				"NOTE: The summary above is authoritative for this evaluation."
			].join("\n")

			const content = await azureChatCompletion(azure.cfg, [
				{ role: "system", content: system },
				{ role: "user", content: user }
			])

			const verdict = parseEvalJson(content)
			expect(verdict.accepted, verdict.reason ?? "LLM rejected version bump").toBe(true)
		},
		300_000
	)
})
