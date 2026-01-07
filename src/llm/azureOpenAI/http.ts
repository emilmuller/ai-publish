import type { AzureOpenAIConfig } from "./config"
import { assertAzureApiVersionSupportsStructuredOutputs } from "./config"
import { getAzureOpenAIClient } from "../openaiSdk"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type AzureChatCompletionUsage = {
	/** Chat Completions API */
	promptTokens?: number
	completionTokens?: number
	totalTokens?: number
	/** Responses API */
	outputTokens?: number
	reasoningTokens?: number
}

export type AzureChatCompletionResult = {
	content: string
	model?: string
	finishReason?: string
	usage?: AzureChatCompletionUsage
}

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

function normalizeMaxTokens(n: number | undefined): number | undefined {
	if (n === undefined) return undefined
	if (!Number.isFinite(n)) return undefined
	const MIN = 64
	const MAX = 32_000
	return Math.max(MIN, Math.min(MAX, Math.trunc(n)))
}

function useResponsesApiFromEnv(): boolean {
	const raw = process.env.AZURE_OPENAI_USE_RESPONSES
	if (!raw) return false
	return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

function reasoningEffortFromEnv(): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null | undefined {
	const raw = (process.env.AZURE_OPENAI_REASONING_EFFORT ?? process.env.AI_PUBLISH_REASONING_EFFORT ?? "").trim()
	if (!raw) return undefined
	const v = raw.toLowerCase()
	if (v === "none" || v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v
	if (v === "null") return null
	return undefined
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

function responsesApiVersionFromEnvOrCfg(cfg: AzureOpenAIConfig): string {
	const raw = process.env.AZURE_OPENAI_RESPONSES_API_VERSION
	if (raw && raw.trim()) return raw.trim()
	// Azure Responses API is currently documented on newer preview API versions.
	if (/^2025-\d{2}-\d{2}(-preview)?$/i.test(cfg.apiVersion)) return cfg.apiVersion
	return "2025-04-01-preview"
}

function mapChatResponseFormatToResponsesTextFormat(responseFormat: any): any | undefined {
	if (!responseFormat || typeof responseFormat !== "object") return undefined
	const t = responseFormat.type
	if (t === "json_schema") {
		const js = responseFormat.json_schema
		if (!js || typeof js !== "object") return undefined
		// Chat Completions: { type: 'json_schema', json_schema: { name, description?, schema, strict? } }
		// Responses: { type: 'json_schema', name, description?, schema, strict? }
		return {
			type: "json_schema",
			...(typeof js.name === "string" ? { name: js.name } : {}),
			...(typeof js.description === "string" ? { description: js.description } : {}),
			...(js.schema && typeof js.schema === "object" ? { schema: js.schema } : {}),
			...(typeof js.strict === "boolean" ? { strict: js.strict } : {})
		}
	}
	if (t === "json_object") return { type: "json_object" }
	if (t === "text") return { type: "text" }
	return undefined
}

async function azureResponsesCompletion(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	}
): Promise<AzureChatCompletionResult> {
	const envMaxTokens = maxTokensFromEnv()
	const requestedMaxTokens = normalizeMaxTokens(params.maxTokens)
	const maxTokens = Math.max(envMaxTokens ?? 0, requestedMaxTokens ?? 0) || 1200
	const responsesApiVersion = responsesApiVersionFromEnvOrCfg(cfg)

	const systemInstructions = params.messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.filter(Boolean)
		.join("\n\n")
	const inputMessages = params.messages
		.filter((m) => m.role !== "system")
		// Azure Responses API appears to be stricter/behind on the multi-part content schema.
		// Using string `content` is supported by the OpenAI SDK types and avoids Azure rejecting `input_text`.
		.map((m) => ({ role: m.role, content: m.content }))

	const textFormat = mapChatResponseFormatToResponsesTextFormat(params.responseFormat)

	const client = await getAzureOpenAIClient({
		endpoint: cfg.endpoint,
		apiKey: cfg.apiKey,
		apiVersion: responsesApiVersion,
		requestTimeoutMs: cfg.requestTimeoutMs
	})
	const response = await client.responses.create({
		model: cfg.deployment,
		...(systemInstructions ? { instructions: systemInstructions } : {}),
		input: inputMessages,
		max_output_tokens: maxTokens,
		// Some Azure reasoning-model deployments reject `temperature` entirely.
		...(reasoningEffortFromEnv() !== undefined ? { reasoning: { effort: reasoningEffortFromEnv() } } : {}),
		...(textFormat ? { text: { format: textFormat } } : {})
	})

	const json = response as any
	if (debugEnabled()) {
		debugLog("azureResponsesCompletion:ok", {
			model: json?.model,
			status: json?.status,
			outputTokens: json?.usage?.output_tokens,
			reasoningTokens: json?.usage?.output_tokens_details?.reasoning_tokens
		})
	}
	const text = parseResponsesOutputText(json)
	if (typeof text !== "string" || !text.trim()) {
		if (debugEnabled()) {
			debugLog("azureResponsesCompletion:missingOutputText", {
				status: json?.status,
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

	return {
		content: text,
		model: typeof json?.model === "string" ? json.model : undefined,
		finishReason: typeof json?.status === "string" ? json.status : undefined,
		usage: {
			outputTokens: typeof json?.usage?.output_tokens === "number" ? json.usage.output_tokens : undefined,
			reasoningTokens:
				typeof json?.usage?.output_tokens_details?.reasoning_tokens === "number"
					? json.usage.output_tokens_details.reasoning_tokens
					: undefined
		}
	}
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
): Promise<AzureChatCompletionResult> {
	if (useResponsesApiFromEnv()) {
		return await azureResponsesCompletion(cfg, params)
	}

	// Structured Outputs (response_format json_schema) requires a sufficiently new Azure API version.
	// Older api versions may silently ignore response_format and return free-form text, causing
	// downstream JSON parsing to fail intermittently.
	if (params.responseFormat?.type === "json_schema") {
		assertAzureApiVersionSupportsStructuredOutputs(cfg.apiVersion)
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
	const envMaxTokens = maxTokensFromEnv()
	const requestedMaxTokens = normalizeMaxTokens(params.maxTokens)
	const maxTokens = Math.max(envMaxTokens ?? 0, requestedMaxTokens ?? 0) || 1200

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

	return {
		content,
		model: typeof json?.model === "string" ? json.model : undefined,
		finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
		usage: {
			promptTokens: typeof json?.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : undefined,
			completionTokens:
				typeof json?.usage?.completion_tokens === "number" ? json.usage.completion_tokens : undefined,
			totalTokens: typeof json?.usage?.total_tokens === "number" ? json.usage.total_tokens : undefined
		}
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
	const res = await azureChatCompletionInner(cfg, params, true)
	return res.content
}

export async function azureChatCompletionWithMeta(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: any
	}
): Promise<AzureChatCompletionResult> {
	return await azureChatCompletionInner(cfg, params, true)
}
