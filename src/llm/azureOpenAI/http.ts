import type { AzureOpenAIConfig } from "./config"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRetryAfterMs(res: Response): number | null {
	const raw = res.headers.get("retry-after")
	if (!raw) return null
	const n = Number(raw)
	if (!Number.isFinite(n) || n < 0) return null
	// Retry-After is usually seconds.
	return Math.trunc(n * 1000)
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599)
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const ctrl = new AbortController()
	const t = setTimeout(() => ctrl.abort(), timeoutMs)
	try {
		return await fetch(url, { ...init, signal: ctrl.signal })
	} finally {
		clearTimeout(t)
	}
}

export async function azureChatCompletion(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	}
): Promise<string> {
	// Azure OpenAI (data-plane) Chat Completions:
	// POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
	const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(
		cfg.deployment
	)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`

	async function postJson(body: any): Promise<Response> {
		return await fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"api-key": cfg.apiKey
				},
				body: JSON.stringify(body)
			},
			cfg.requestTimeoutMs
		)
	}

	const baseBody = {
		messages: params.messages,
		temperature: params.temperature ?? 0,
		...(params.responseFormat ? { response_format: params.responseFormat } : {})
	}

	// Some Azure deployments (notably newer reasoning models) reject `max_tokens` in favor of
	// `max_completion_tokens`. For compatibility across deployments, negotiate the correct field
	// once, then apply retries/backoff for transient failures.
	let tokenField: "max_completion_tokens" | "max_tokens" = "max_completion_tokens"
	const maxTokens = params.maxTokens ?? 1200

	function makeBody(): any {
		return tokenField === "max_completion_tokens"
			? { ...baseBody, max_completion_tokens: maxTokens }
			: { ...baseBody, max_tokens: maxTokens }
	}

	async function requestOnce(): Promise<Response> {
		return await postJson(makeBody())
	}

	// First request (no backoff); if it fails due to token field incompatibility, switch and retry once.
	let res: Response
	try {
		res = await requestOnce()
	} catch (e) {
		throw new Error(`Azure OpenAI request failed (network/timeout): ${(e as Error)?.message ?? String(e)}`)
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		const msg = text || res.statusText
		const looksLikeUnsupportedMaxCompletion =
			res.status === 400 && /max_completion_tokens/i.test(msg) && /unsupported/i.test(msg)
		if (looksLikeUnsupportedMaxCompletion) {
			tokenField = "max_tokens"
			res = await requestOnce()
		}
	}

	const MAX_ATTEMPTS = 3
	for (let attempt = 1; !res.ok && attempt < MAX_ATTEMPTS; attempt++) {
		const status = res.status
		const retryable = isRetryableStatus(status)
		if (!retryable) break

		const retryAfterMs = getRetryAfterMs(res)
		const backoffMs = retryAfterMs ?? 500 * Math.pow(2, attempt - 1)
		await sleep(backoffMs)

		try {
			res = await requestOnce()
		} catch (e) {
			if (attempt >= MAX_ATTEMPTS - 1) {
				throw new Error(`Azure OpenAI request failed (network/timeout): ${(e as Error)?.message ?? String(e)}`)
			}
			// Treat network/timeouts as transient.
			res = new Response(null, { status: 503, statusText: "Network error" })
		}
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		const msg = text || res.statusText
		const looksLikeUnsupportedMaxTokens = res.status === 400 && /max_tokens/i.test(msg) && /unsupported/i.test(msg)
		if (looksLikeUnsupportedMaxTokens && tokenField === "max_tokens") {
			throw new Error(`Azure OpenAI request failed (${res.status}): ${msg}`)
		}
		throw new Error(`Azure OpenAI request failed (${res.status}): ${msg}`)
	}

	const json = (await res.json()) as any
	const content = json?.choices?.[0]?.message?.content
	if (typeof content !== "string" || !content.trim()) {
		throw new Error("Azure OpenAI response missing message content")
	}
	return content
}
