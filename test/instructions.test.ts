import { describe, expect, test } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveInstructions } from "../src/instructions/resolveInstructions"

describe("instructions", () => {
	test("normalizes Windows-style separators in targetPath", async () => {
		const dir = join(tmpdir(), `ai-publish-instructions-${randomUUID()}`)
		await mkdir(dir, { recursive: true })

		// Minimal instruction file so resolution has something to read.
		await writeFile(join(dir, "AGENTS.md"), "key: value\n", "utf8")

		// Create a nested target file.
		await mkdir(join(dir, "src", "sub"), { recursive: true })
		await writeFile(join(dir, "src", "sub", "file.ts"), "export {}\n", "utf8")

		const res = await resolveInstructions({ cwd: dir, targetPath: "src\\sub\\file.ts" })
		expect(res.targetPath).toBe("src/sub/file.ts")
	})
})
