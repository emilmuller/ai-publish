import type { Surface } from "../diff/types"

export type ClassifyOverrides = {
	publicPathPrefixes?: string[]
	publicFilePaths?: string[]
	internalPathPrefixes?: string[]
}

function hasAnyPrefix(path: string, prefixes: string[]): boolean {
	const normalized = path.replace(/\\/g, "/")
	return prefixes.some((p) => normalized === p || normalized.startsWith(`${p}/`))
}

export function classifyFile(path: string, overrides?: ClassifyOverrides): Surface {
	const normalized = path.replace(/\\/g, "/")
	const lower = normalized.toLowerCase()

	if (hasAnyPrefix(lower, ["docs"]) || lower.endsWith(".md")) return "docs"

	if (
		hasAnyPrefix(lower, ["test", "tests", "__tests__"]) ||
		lower.includes("/__tests__/") ||
		lower.includes(".tests/") ||
		lower.includes(".test/") ||
		lower.endsWith(".test.ts") ||
		lower.endsWith(".spec.ts")
	) {
		return "tests"
	}

	if (
		hasAnyPrefix(lower, [".github", ".devcontainer"]) ||
		lower.startsWith("infra/") ||
		lower.startsWith("terraform/") ||
		lower.startsWith("k8s/") ||
		lower.endsWith(".tf") ||
		lower.endsWith(".bicep")
	) {
		return "infra"
	}

	// CLI entrypoints and bins
	if (
		hasAnyPrefix(lower, ["bin", "scripts"]) ||
		lower.includes("/cli") ||
		lower.endsWith("cli.ts") ||
		lower.endsWith("cli.js")
	) {
		return "cli"
	}

	// Config / metadata
	if (
		lower === "package.json" ||
		lower === "package-lock.json" ||
		lower === "pnpm-lock.yaml" ||
		lower === "yarn.lock" ||
		lower.endsWith(".json") ||
		lower.endsWith(".yml") ||
		lower.endsWith(".yaml") ||
		lower.endsWith(".toml") ||
		lower.endsWith(".ini")
	) {
		return "config"
	}

	const publicPathPrefixes = (overrides?.publicPathPrefixes ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase())
	const publicFilePaths = (overrides?.publicFilePaths ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase())
	const internalPathPrefixes = (overrides?.internalPathPrefixes ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase())

	// Allow repo-specific overrides for public/internal boundaries.
	// These are applied after the obvious buckets above (docs/tests/infra/cli/config).
	if (internalPathPrefixes.length && hasAnyPrefix(lower, internalPathPrefixes)) return "internal"
	if (publicFilePaths.length && publicFilePaths.includes(lower)) return "public-api"
	if (publicPathPrefixes.length && hasAnyPrefix(lower, publicPathPrefixes)) return "public-api"

	// Public API heuristics: small, deterministic, conservative.
	if (
		lower === "src/index.ts" ||
		lower === "src/index.js" ||
		lower === "src/index.mjs" ||
		lower === "src/index.cjs" ||
		lower === "src/lib.rs" ||
		lower.startsWith("src/public/") ||
		lower.startsWith("src/api/") ||
		lower.startsWith("public/") ||
		lower.startsWith("api/") ||
		lower.startsWith("include/")
	) {
		return "public-api"
	}

	// Everything else under src/ defaults to internal.
	if (lower.startsWith("src/")) return "internal"

	// Default fallback.
	return "internal"
}
