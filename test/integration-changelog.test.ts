import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { runGitOrThrow } from "../src/git/runGit"
import { runChangelogPipeline } from "../src/pipeline/runChangelogPipeline"
import { makeDeterministicTestLLMClient } from "./deterministicTestLLMClient"

describe("Integration: changelog generation (network-free)", () => {
	test("generates stable markdown for add/modify/delete", async () => {
		const { dir } = await makeTempGitRepo()

		// Establish a base commit that already contains a few files.
		await commitChange(dir, "config.yml", "name: base\n", "add config base")
		await commitChange(dir, "old.txt", "to be removed\n", "add old file")

		const base = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: dir })).trim()

		// Net changes (base..HEAD): delete old.txt, modify config.yml, add src/public/newApi.ts
		await runGitOrThrow(["rm", "old.txt"], { cwd: dir })
		await runGitOrThrow(["commit", "-m", "remove old"], { cwd: dir })

		await commitChange(dir, "config.yml", "name: changed\n", "change config")
		await commitChange(dir, "src/public/newApi.ts", "export const foo = 1\n", "add public api")

		const res = await runChangelogPipeline({ base, cwd: dir, llmClient: makeDeterministicTestLLMClient() })
		const normalized = res.markdown.replace(
			/^# Changelog \((?:[0-9a-f]{7,40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.\.(?:[0-9a-f]{7,40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|HEAD)\)$/m,
			"# Changelog (<base>..<head>)"
		)

		// End-to-end assertion: stable markdown structure + deterministic bullet ordering.
		expect(normalized).toMatchInlineSnapshot(`
			"# Changelog (<base>..<head>)

			- Expose foo in public API
			- Update name from 'base' to 'changed'
			- Removed obsolete content"
		`)
	}, 60_000)
})
