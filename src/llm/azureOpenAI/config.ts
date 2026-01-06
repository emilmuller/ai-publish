export type AzureOpenAIConfig = {
	endpoint: string
	apiKey: string
	deployment: string
	apiVersion: string
	requestTimeoutMs: number
}

function requireEnv(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`Missing required env var: ${name}`)
	return v
}

function getOptionalEnv(name: string): string | undefined {
	const v = process.env[name]
	return v && v.trim() ? v : undefined
}

function parseTimeoutMsFromEnv(name: string, fallbackMs: number): number {
	const raw = getOptionalEnv(name)
	if (!raw) return fallbackMs
	const n = Number(raw)
	if (!Number.isFinite(n)) {
		throw new Error(`Invalid ${name} (expected number of milliseconds): ${raw}`)
	}
	// Clamp to a reasonable range to avoid accidental "0" or huge timeouts.
	const MIN_MS = 1_000
	const MAX_MS = 10 * 60_000
	return Math.max(MIN_MS, Math.min(MAX_MS, Math.trunc(n)))
}

export function toConfigFromEnv(): AzureOpenAIConfig {
	const endpoint = requireEnv("AZURE_OPENAI_ENDPOINT").replace(/\/$/, "")
	const apiKey = requireEnv("AZURE_OPENAI_API_KEY")
	const deployment = requireEnv("AZURE_OPENAI_DEPLOYMENT")
	const apiVersion = getOptionalEnv("AZURE_OPENAI_API_VERSION") ?? "2024-08-01-preview"
	const requestTimeoutMs = parseTimeoutMsFromEnv("AZURE_OPENAI_TIMEOUT_MS", 60_000)
	return { endpoint, apiKey, deployment, apiVersion, requestTimeoutMs }
}
