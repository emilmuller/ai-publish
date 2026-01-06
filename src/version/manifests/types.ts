export type ManifestType = "npm" | "dotnet" | "rust" | "python" | "go"

export type ManifestTarget = {
	/** Which manifest format to update. */
	type: ManifestType
	/** Path to the manifest file, relative to cwd unless absolute. */
	path?: string
	/** If false, do not write to disk (compute only). */
	write?: boolean
}
