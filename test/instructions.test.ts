import { describe, expect, test } from "vitest"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveInstructions } from "../src/instructions/resolveInstructions"

describe("instructions", () => {
	test("normalizes Windows-style separators in targetPath", async () => {
		const dir = join(tmpdir(), `ai-publish-instructions-${randomUUID()}`)
		await mkdir(dir, { recursive: true })

		const res = await resolveInstructions({ cwd: dir, targetPath: "src\\sub\\file.ts" })
		expect(res.targetPath).toBe("src/sub/file.ts")
	})
})
