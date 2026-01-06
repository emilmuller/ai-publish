import type { OpenAIConfig } from "./config"

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

function extractErrorMessage(bodyText: string): string {
	const t = (bodyText ?? "").trim()
	if (!t) return ""
	try {
		const parsed = JSON.parse(t) as any
		const msg = parsed?.error?.message
		return typeof msg === "string" && msg.trim() ? msg.trim() : t
	} catch {
		return t
	}
}

export async function openAIChatCompletion(
	cfg: OpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	}
): Promise<string> {
	const url = `${cfg.baseUrl}/chat/completions`

	async function postJson(body: any): Promise<Response> {
		return await fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cfg.apiKey}`
				},
				body: JSON.stringify(body)
			},
			cfg.requestTimeoutMs
		)
	}

	const maxTokens = params.maxTokens ?? 1200
	const body = {
		model: cfg.model,
		messages: params.messages,
		temperature: params.temperature ?? 0,
		max_tokens: maxTokens,
		...(params.responseFormat ? { response_format: params.responseFormat } : {})
	}

	async function requestOnce(): Promise<Response> {
		return await postJson(body)
	}

	let res: Response
	try {
		res = await requestOnce()
	} catch (e) {
		throw new Error(`OpenAI request failed (network/timeout): ${(e as Error)?.message ?? String(e)}`)
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
				throw new Error(`OpenAI request failed (network/timeout): ${(e as Error)?.message ?? String(e)}`)
			}
			res = new Response(null, { status: 503, statusText: "Network error" })
		}
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		const msg = extractErrorMessage(text) || res.statusText
		throw new Error(`OpenAI request failed (${res.status}): ${msg}`)
	}

	const json = (await res.json()) as any
	const content = json?.choices?.[0]?.message?.content
	if (typeof content !== "string" || !content.trim()) {
		throw new Error("OpenAI response missing message content")
	}
	return content
}
