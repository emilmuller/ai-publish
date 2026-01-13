import { describe, expect, test } from "vitest"
import { buildDotnetNugetPushArgs } from "../src/dotnet/dotnetNugetPushArgs"

describe("buildDotnetNugetPushArgs", () => {
	test("includes --source when provided", () => {
		const args = buildDotnetNugetPushArgs({
			pkgAbs: "/tmp/pkg.nupkg",
			source: "https://example.invalid/v3/index.json",
			apiKey: "k"
		})
		expect(args).toEqual([
			"nuget",
			"push",
			"/tmp/pkg.nupkg",
			"--source",
			"https://example.invalid/v3/index.json",
			"--api-key",
			"k",
			"--skip-duplicate"
		])
	})

	test("omits --source when not provided (uses nuget.config default)", () => {
		const args = buildDotnetNugetPushArgs({ pkgAbs: "/tmp/pkg.nupkg", apiKey: "k" })
		expect(args).toEqual(["nuget", "push", "/tmp/pkg.nupkg", "--api-key", "k", "--skip-duplicate"])
	})
})
