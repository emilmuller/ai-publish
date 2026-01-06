import { describe, expect, test } from "vitest"
import { updateCargoTomlVersion } from "../src/version/manifests"
import { updateCsprojVersion } from "../src/version/manifests"
import { updateNpmPackageJsonVersion } from "../src/version/manifests"

describe("manifest version update", () => {
	test("npm: updates version field", () => {
		const raw = JSON.stringify({ name: "x", version: "0.0.0", other: { a: 1 } }, null, 2) + "\n"
		const next = updateNpmPackageJsonVersion(raw, "1.2.3")
		const parsed = JSON.parse(next) as any
		expect(parsed.version).toBe("1.2.3")
	})

	test("dotnet: updates <Version> when present", () => {
		const raw = [
			"<Project>",
			"  <PropertyGroup>",
			"    <TargetFramework>net8.0</TargetFramework>",
			"    <Version>0.1.0</Version>",
			"  </PropertyGroup>",
			"</Project>",
			""
		].join("\n")
		const next = updateCsprojVersion(raw, "1.2.3")
		expect(next).toMatch(/<Version>1\.2\.3<\/Version>/)
	})

	test("dotnet: inserts <Version> when missing", () => {
		const raw = [
			"<Project>",
			"  <PropertyGroup>",
			"    <TargetFramework>net8.0</TargetFramework>",
			"  </PropertyGroup>",
			"</Project>",
			""
		].join("\n")
		const next = updateCsprojVersion(raw, "1.2.3")
		expect(next).toMatch(/<PropertyGroup>[\s\S]*<Version>1\.2\.3<\/Version>/)
	})

	test("rust: updates [package] version", () => {
		const raw = ["[package]", 'name = "x"', 'version = "0.1.0"', "", "[dependencies]", 'serde = "1"', ""].join("\n")
		const next = updateCargoTomlVersion(raw, "1.2.3")
		expect(next).toMatch(/^version\s*=\s*\"1\.2\.3\"$/m)
	})
})
