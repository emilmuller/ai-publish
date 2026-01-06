export type OpenAIConfig = {
	baseUrl: string
	apiKey: string
	model: string
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
	const MIN_MS = 1_000
	const MAX_MS = 10 * 60_000
	return Math.max(MIN_MS, Math.min(MAX_MS, Math.trunc(n)))
}

export function toConfigFromEnv(): OpenAIConfig {
	const baseUrl = (getOptionalEnv("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "")
	const apiKey = requireEnv("OPENAI_API_KEY")
	const model = requireEnv("OPENAI_MODEL")
	const requestTimeoutMs = parseTimeoutMsFromEnv("OPENAI_TIMEOUT_MS", 60_000)
	return { baseUrl, apiKey, model, requestTimeoutMs }
}
