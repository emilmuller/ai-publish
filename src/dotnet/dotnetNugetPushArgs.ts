export function buildDotnetNugetPushArgs(params: { pkgAbs: string; source?: string; apiKey: string }): string[] {
	const args = ["nuget", "push", params.pkgAbs]
	if (params.source) {
		args.push("--source", params.source)
	}
	args.push("--api-key", params.apiKey, "--skip-duplicate")
	return args
}
