export function updateNpmPackageJsonVersion(raw: string, nextVersion: string): string {
	const parsed = JSON.parse(raw) as any
	parsed.version = nextVersion
	return JSON.stringify(parsed, null, 2) + "\n"
}
