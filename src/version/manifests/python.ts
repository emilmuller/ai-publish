import semver from "semver"

function normalizeSemverOrThrow(raw: string, label: string): string {
	const trimmed = raw.trim()
	const v = semver.valid(trimmed) ?? (trimmed.startsWith("v") ? semver.valid(trimmed.slice(1)) : null)
	if (!v) throw new Error(`${label} is not valid semver: ${raw}`)
	return v
}

export function readPyProjectTomlVersion(raw: string): string {
	const lines = raw.replace(/\r\n/g, "\n").split("\n")
	let section: string | null = null

	for (const line of lines) {
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
		if (header) {
			section = header[1]!.trim()
			continue
		}

		if (section !== "project" && section !== "tool.poetry") continue
		const m = /^\s*version\s*=\s*(["'])([^"']*)(\1)\s*(?:#.*)?$/.exec(line)
		if (!m) continue
		return normalizeSemverOrThrow(m[2] ?? "", "pyproject.toml version")
	}

	throw new Error("pyproject.toml does not contain a version field in [project] or [tool.poetry]")
}

export function updatePyProjectTomlVersion(raw: string, nextVersion: string): string {
	// Minimal, deterministic updater for common pyproject.toml layouts:
	// - PEP 621: [project] version = "x.y.z"
	// - Poetry:  [tool.poetry] version = "x.y.z"
	// We update the first matching `version = ...` line within either section.
	const lines = raw.replace(/\r\n/g, "\n").split("\n")
	let section: string | null = null
	let updated = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ""
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
		if (header) {
			section = header[1]!.trim()
			continue
		}

		if (updated) continue
		if (section !== "project" && section !== "tool.poetry") continue

		const m = /^(\s*version\s*=\s*)(["'])([^"']*)(\2\s*)(#.*)?$/.exec(line)
		if (!m) continue

		const prefix = m[1]!
		const quote = m[2]!
		const suffix = m[4]!
		const comment = m[5] ?? ""
		lines[i] = `${prefix}${quote}${nextVersion}${quote}${suffix}${comment}`
		updated = true
	}

	if (!updated) {
		throw new Error("pyproject.toml does not contain a version field in [project] or [tool.poetry]")
	}

	return lines.join("\n")
}
