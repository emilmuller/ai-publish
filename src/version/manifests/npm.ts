import semver from "semver"

function normalizeSemverOrThrow(raw: string, label: string): string {
	const trimmed = raw.trim()
	const v = semver.valid(trimmed) ?? (trimmed.startsWith("v") ? semver.valid(trimmed.slice(1)) : null)
	if (!v) throw new Error(`${label} is not valid semver: ${raw}`)
	return v
}

export function readNpmPackageJsonVersion(raw: string): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error("package.json is not valid JSON")
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("package.json is not a JSON object")
	}
	const obj = parsed as Record<string, unknown>
	const version = typeof obj.version === "string" ? obj.version : ""
	if (!version.trim()) throw new Error("package.json does not contain a version field")
	return normalizeSemverOrThrow(version, "package.json version")
}

export function updateNpmPackageJsonVersion(raw: string, nextVersion: string): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error("package.json is not valid JSON")
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("package.json is not a JSON object")
	}
	const obj = parsed as Record<string, unknown>
	return JSON.stringify({ ...obj, version: nextVersion }, null, 2) + "\n"
}
