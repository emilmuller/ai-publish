export type AzureOpenAIConfig = {
	endpoint: string
	apiKey: string
	deployment: string
	apiVersion: string
	requestTimeoutMs: number
}

const MIN_STRUCTURED_OUTPUTS_API_VERSION_NUM = 20240801

function azureApiVersionToNumber(apiVersion: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/i.exec(apiVersion.trim())
	if (!m) return null
	const y = Number(m[1])
	const mo = Number(m[2])
	const d = Number(m[3])
	if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
	return y * 10000 + mo * 100 + d
}

export function assertAzureApiVersionSupportsStructuredOutputs(apiVersion: string): void {
	const n = azureApiVersionToNumber(apiVersion)
	if (n === null) {
		throw new Error(`Invalid AZURE_OPENAI_API_VERSION: ${apiVersion}. Expected a value like 2024-08-01-preview.`)
	}
	if (n < MIN_STRUCTURED_OUTPUTS_API_VERSION_NUM) {
		throw new Error(
			`Azure OpenAI Structured Outputs (response_format json_schema) requires AZURE_OPENAI_API_VERSION ` +
				`to be 2024-08-01-preview or later (current: ${apiVersion}).`
		)
	}
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
