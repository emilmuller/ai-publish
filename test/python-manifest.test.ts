import { describe, expect, test } from "vitest"
import { updatePyProjectTomlVersion } from "../src/version/manifests"

describe("python manifest", () => {
	test("updates [project] version", () => {
		const raw = ["[project]", 'name = "pkg"', 'version = "1.2.3"', "", "[tool.other]", "x = 1"].join("\n")
		const out = updatePyProjectTomlVersion(raw, "1.2.4")
		expect(out).toMatch(/version\s*=\s*\"1\.2\.4\"/)
	})

	test("updates [tool.poetry] version", () => {
		const raw = ["[tool.poetry]", 'name = "pkg"', 'version = "1.2.3"'].join("\n")
		const out = updatePyProjectTomlVersion(raw, "1.2.4")
		expect(out).toMatch(/version\s*=\s*\"1\.2\.4\"/)
	})
})
