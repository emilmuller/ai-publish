import { describe, expect, test } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp } from "node:fs/promises"
import { listDotnetPackages } from "../src/dotnet/listDotnetPackages"

describe("listDotnetPackages", () => {
	test("filters to the expected version when present", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ai-publish-dotnet-"))
		const projectDir = join(dir, "My.Project")
		const outDir = join(projectDir, "bin", "Release")
		await mkdir(outDir, { recursive: true })

		await writeFile(join(outDir, "My.Project.0.1.0-preview.5.nupkg"), "")
		await writeFile(join(outDir, "My.Project.0.1.0-preview.6.nupkg"), "")
		await writeFile(join(outDir, "My.Project.0.1.0-preview.6.snupkg"), "")

		const pkgs = await listDotnetPackages({
			cwd: dir,
			projectPath: "My.Project/My.Project.csproj",
			expectedVersion: "0.1.0-preview.6"
		})

		expect(pkgs).toHaveLength(1)
		expect(pkgs[0]!.replace(/\\/g, "/")).toMatch(/0\.1\.0-preview\.6\.nupkg$/)
	})

	test("falls back to listing all packages when expected version is not found", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ai-publish-dotnet-"))
		const projectDir = join(dir, "My.Project")
		const outDir = join(projectDir, "bin", "Release")
		await mkdir(outDir, { recursive: true })

		await writeFile(join(outDir, "My.Project.0.1.0-preview.5.nupkg"), "")
		await writeFile(join(outDir, "My.Project.0.1.0-preview.6.nupkg"), "")

		const pkgs = await listDotnetPackages({
			cwd: dir,
			projectPath: "My.Project/My.Project.csproj",
			expectedVersion: "0.1.0-preview.999"
		})

		expect(pkgs).toHaveLength(2)
		const normalized = pkgs.map((p) => p.replace(/\\/g, "/"))
		expect(normalized.some((p) => p.endsWith(".0.1.0-preview.5.nupkg"))).toBe(true)
		expect(normalized.some((p) => p.endsWith(".0.1.0-preview.6.nupkg"))).toBe(true)
	})
})
