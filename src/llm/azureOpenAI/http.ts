import type { AzureOpenAIConfig } from "./config"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1" || process.env.AI_PUBLISH_DEBUG === "1"
}

function debugLog(...args: any[]) {
	if (!debugEnabled()) return
	// eslint-disable-next-line no-console
	console.error("[ai-publish][debug]", ...args)
}

function maxTokensFromEnv(): number | undefined {
	const raw = process.env.AZURE_OPENAI_MAX_TOKENS
	if (!raw || !raw.trim()) return undefined
	const n = Number(raw)
	if (!Number.isFinite(n)) return undefined
	// Keep within a reasonable range to avoid accidental extremes.
	const MIN = 64
	const MAX = 32_000
	return Math.max(MIN, Math.min(MAX, Math.trunc(n)))
}

function useResponsesApiFromEnv(): boolean {
	const raw = process.env.AZURE_OPENAI_USE_RESPONSES
	if (!raw) return false
	return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

function parseResponsesOutputText(json: any): string {
	if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text

	// Fallback: derive from output message(s)
	const out = json?.output
	if (!Array.isArray(out)) return ""
	const parts: string[] = []
	for (const item of out) {
		const content = item?.content
		if (!Array.isArray(content)) continue
		for (const c of content) {
			if (c && typeof c.text === "string") parts.push(c.text)
		}
	}
	return parts.join("")
}

async function azureResponsesCompletion(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	}
): Promise<string> {
	// Azure OpenAI v1 Responses API:
	// POST {endpoint}/openai/v1/responses
	const url = `${cfg.endpoint}/openai/v1/responses`
	const maxTokens = params.maxTokens ?? maxTokensFromEnv() ?? 1200

	const res = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": cfg.apiKey
			},
			body: JSON.stringify({
				model: cfg.deployment,
				input: params.messages.map((m) => ({ role: m.role, content: m.content })),
				temperature: params.temperature ?? 0,
				max_output_tokens: maxTokens,
				...(params.responseFormat ? { response_format: params.responseFormat } : {})
			})
		},
		cfg.requestTimeoutMs
	)

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		const msg = text || res.statusText
		throw new Error(`Azure OpenAI responses request failed (${res.status}): ${msg}`)
	}

	const json = (await res.json()) as any
	const text = parseResponsesOutputText(json)
	if (typeof text !== "string" || !text.trim()) {
		if (debugEnabled()) {
			debugLog("azureResponsesCompletion:missingOutputText", {
				status: res.status,
				model: json?.model,
				statusText: json?.status
			})
			try {
				debugLog("azureResponsesCompletion:responseSnippet", JSON.stringify(json).slice(0, 2000))
			} catch {
				// ignore
			}
		}
		throw new Error("Azure OpenAI responses response missing output_text")
	}

	return text
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

async function azureChatCompletionInner(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	},
	allowNoFormatRetry: boolean
): Promise<string> {
	if (useResponsesApiFromEnv()) {
		return await azureResponsesCompletion(cfg, params)
	}

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

	function makeBaseBody(withFormat: boolean): any {
		return {
			messages: params.messages,
			temperature: params.temperature ?? 0,
			...(withFormat && params.responseFormat ? { response_format: params.responseFormat } : {})
		}
	}

	// Some Azure deployments (notably newer reasoning models) reject `max_tokens` in favor of
	// `max_completion_tokens`. For compatibility across deployments, negotiate the correct field
	// once, then apply retries/backoff for transient failures.
	let tokenField: "max_completion_tokens" | "max_tokens" = "max_completion_tokens"
	const maxTokens = params.maxTokens ?? maxTokensFromEnv() ?? 1200

	function makeBody(withFormat: boolean): any {
		const baseBody = makeBaseBody(withFormat)
		return tokenField === "max_completion_tokens"
			? { ...baseBody, max_completion_tokens: maxTokens }
			: { ...baseBody, max_tokens: maxTokens }
	}

	async function requestOnce(withFormat: boolean): Promise<Response> {
		return await postJson(makeBody(withFormat))
	}

	// First request (no backoff); if it fails due to token field incompatibility, switch and retry once.
	let res: Response
	try {
		res = await requestOnce(true)
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
			res = await requestOnce(true)
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
			res = await requestOnce(true)
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
	const choice = json?.choices?.[0]
	const message = choice?.message

	let content: unknown = message?.content
	if (Array.isArray(content)) {
		// Some providers/models return an array of content parts.
		content = content
			.map((p: any) => {
				if (typeof p === "string") return p
				if (p && typeof p.text === "string") return p.text
				return ""
			})
			.join("")
	}

	if (typeof content !== "string" || !content.trim()) {
		if (debugEnabled()) {
			debugLog("azureChatCompletion:missingContent", {
				status: res.status,
				finish_reason: choice?.finish_reason,
				messageKeys: message ? Object.keys(message) : null
			})
			try {
				debugLog("azureChatCompletion:responseSnippet", JSON.stringify(json).slice(0, 2000))
			} catch {
				// ignore
			}
		}
		if (message?.tool_calls) {
			throw new Error("Azure OpenAI response requested tool calls (no message content)")
		}
		if (allowNoFormatRetry && params.responseFormat) {
			debugLog("azureChatCompletion:retryWithoutResponseFormat")
			return await azureChatCompletionInner(cfg, { ...params, responseFormat: undefined }, false)
		}

		// GPT-5.x deployments can behave poorly on chat-completions (empty content + reasoning only).
		// As a best-effort fallback, try the v1 Responses API once.
		const model = typeof json?.model === "string" ? json.model : ""
		if (model.startsWith("gpt-5") || model.startsWith("gpt-5.")) {
			debugLog("azureChatCompletion:fallbackToResponses", { model })
			return await azureResponsesCompletion(cfg, params)
		}

		const finish = typeof choice?.finish_reason === "string" ? ` (finish_reason=${choice.finish_reason})` : ""
		throw new Error(`Azure OpenAI response missing message content${finish}`)
	}

	return content
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
	return await azureChatCompletionInner(cfg, params, true)
}
