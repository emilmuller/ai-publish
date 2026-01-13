import { readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export async function listDotnetPackages(params: {
	cwd: string
	projectPath: string
	expectedVersion?: string
}): Promise<string[]> {
	const projectAbs = resolve(params.cwd, params.projectPath)
	const projectDir = dirname(projectAbs)
	const outDir = join(projectDir, "bin", "Release")

	const entries = await readdir(outDir, { withFileTypes: true })
	const pkgs = entries
		.filter((e) => e.isFile())
		.map((e) => e.name)
		.filter((n) => n.endsWith(".nupkg") && !n.endsWith(".snupkg"))
		.sort((a, b) => a.localeCompare(b))
		.map((n) => join(outDir, n))

	if (!pkgs.length) {
		throw new Error(`No .nupkg files found under ${outDir}`)
	}

	if (params.expectedVersion) {
		const suffix = `.${params.expectedVersion}.nupkg`
		const matching = pkgs.filter((p) => p.replace(/\\/g, "/").endsWith(suffix))
		if (matching.length) return matching
	}

	return pkgs
}
