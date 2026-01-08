import semver from "semver"

function normalizeSemverOrThrow(raw: string, label: string): string {
	const trimmed = raw.trim()
	const v = semver.valid(trimmed) ?? (trimmed.startsWith("v") ? semver.valid(trimmed.slice(1)) : null)
	if (!v) throw new Error(`${label} is not valid semver: ${raw}`)
	return v
}

export function readCargoTomlVersion(raw: string): string {
	const lines = raw.replace(/\r\n/g, "\n").split("\n")
	let inPackage = false

	for (const line of lines) {
		const trimmed = line.trim()
		if (isSectionHeader(trimmed)) {
			inPackage = trimmed === "[package]"
			continue
		}
		if (!inPackage) continue
		if (/^\s*#/.test(trimmed)) continue
		const m = /^\s*version\s*=\s*"([^"]*)"\s*$/.exec(line)
		if (!m) continue
		return normalizeSemverOrThrow(m[1] ?? "", "Cargo.toml version")
	}

	throw new Error('Unable to find [package] version = "..." in Cargo.toml')
}

function isSectionHeader(line: string): boolean {
	return /^\s*\[[^\]]+\]\s*$/.test(line)
}

export function updateCargoTomlVersion(raw: string, nextVersion: string): string {
	const newline = raw.includes("\r\n") ? "\r\n" : "\n"
	const lines = raw.split(/\r?\n/)

	let inPackage = false
	let updated = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ""
		const trimmed = line.trim()

		if (isSectionHeader(trimmed)) {
			inPackage = trimmed === "[package]"
			continue
		}

		if (!inPackage) continue

		// Match: version = "x" (allow whitespace). Avoid touching commented lines.
		if (/^\s*#/.test(trimmed)) continue

		const m = line.match(/^(\s*version\s*=\s*)"([^"]*)"(\s*)$/)
		if (m) {
			lines[i] = `${m[1]}"${nextVersion}"${m[3]}`
			updated = true
			break
		}
	}

	if (!updated) {
		throw new Error('Unable to find [package] version = "..." in Cargo.toml')
	}

	return lines.join(newline) + (raw.endsWith("\n") || raw.endsWith("\r\n") ? "" : newline)
}
