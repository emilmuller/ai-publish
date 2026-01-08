import { describe, expect, test } from "vitest"
import { makeTempGitRepo, commitChange } from "./gitFixture"
import { resolveVersionBase } from "../src/version/resolveVersionBase"

describe("resolveVersionBase (go)", () => {
	test("no tags + go manifest requires --previous-version", async () => {
		const { dir } = await makeTempGitRepo()
		await commitChange(dir, "go.mod", "module example.com/x\n\ngo 1.22\n", "add go.mod")

		await expect(
			resolveVersionBase({
				cwd: dir,
				manifest: { type: "go", path: "go.mod", write: false }
			})
		).rejects.toThrow(/--previous-version/i)
	})
})
