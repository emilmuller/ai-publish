export function updateGoModVersion(raw: string, _nextVersion: string): string {
	// Go modules do not carry a semver version field in go.mod.
	// The version is represented by the git tag (vX.Y.Z) and module proxy semantics.
	// This updater is therefore a deterministic no-op.
	return raw
}
