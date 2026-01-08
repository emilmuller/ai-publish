import type { AzureOpenAIConfig } from "./config"
import { assertAzureApiVersionSupportsStructuredOutputs } from "./config"
import { getAzureOpenAIClient } from "../openaiSdk"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

function asRecord(v: unknown): Record<string, unknown> | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null
	return v as Record<string, unknown>
}

function asArray(v: unknown): unknown[] | null {
	return Array.isArray(v) ? v : null
}

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

type StreamTokenHandler = (chunk: string) => void

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function debugEnabled(): boolean {
	return process.env.AI_PUBLISH_DEBUG_CLI === "1" || process.env.AI_PUBLISH_DEBUG === "1"
}

function debugLog(...args: unknown[]) {
	if (!debugEnabled()) return

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

function parseResponsesOutputText(json: unknown): string {
	const rec = asRecord(json)
	if (typeof rec?.output_text === "string" && rec.output_text.trim()) return rec.output_text

	// Fallback: derive from output message(s)
	const out = rec?.output
	if (!Array.isArray(out)) return ""
	const parts: string[] = []
	for (const item of out) {
		const itemRec = asRecord(item)
		const content = itemRec?.content
		if (!Array.isArray(content)) continue
		for (const c of content) {
			const cRec = asRecord(c)
			if (cRec && typeof cRec.text === "string") parts.push(cRec.text)
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

function mapChatResponseFormatToResponsesTextFormat(responseFormat: unknown): unknown | undefined {
	const rf = asRecord(responseFormat)
	if (!rf) return undefined
	const t = typeof rf.type === "string" ? rf.type : ""
	if (t === "json_schema") {
		const js = asRecord(rf.json_schema)
		if (!js) return undefined
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
		responseFormat?: unknown
		onToken?: StreamTokenHandler
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

	// Best-effort token streaming via the OpenAI SDK if available.
	if (params.onToken && client?.responses && typeof client.responses.stream === "function") {
		const stream = client.responses.stream({
			model: cfg.deployment,
			...(systemInstructions ? { instructions: systemInstructions } : {}),
			input: inputMessages,
			max_output_tokens: maxTokens,
			...(reasoningEffortFromEnv() !== undefined ? { reasoning: { effort: reasoningEffortFromEnv() } } : {}),
			...(textFormat ? { text: { format: textFormat } } : {})
		})
		try {
			for await (const ev of stream) {
				const evRec = asRecord(ev)
				const typeVal = typeof evRec?.type === "string" ? evRec.type : ""
				// Most OpenAI SDK streams emit delta events for output_text.
				const delta = typeof evRec?.delta === "string" ? evRec.delta : undefined
				if (
					delta &&
					(typeVal.includes("output_text") || typeVal.endsWith(".delta") || typeVal.includes("delta"))
				) {
					params.onToken(delta)
					continue
				}
				const text = typeof evRec?.text === "string" ? evRec.text : undefined
				if (text && (typeVal.includes("output_text") || typeVal.endsWith(".delta"))) {
					params.onToken(text)
				}
			}
		} finally {
			// Ensure the stream is cleaned up if supported.
			if (typeof stream.close === "function") {
				try {
					stream.close()
				} catch {
					// ignore
				}
			}
		}
		const final = typeof stream.finalResponse === "function" ? await stream.finalResponse() : null
		if (final) {
			const text = parseResponsesOutputText(final)
			return {
				content: text,
				model: (() => {
					const rec = asRecord(final)
					return typeof rec?.model === "string" ? rec.model : undefined
				})(),
				finishReason: (() => {
					const rec = asRecord(final)
					return typeof rec?.status === "string" ? rec.status : undefined
				})(),
				usage: {
					outputTokens: (() => {
						const rec = asRecord(final)
						const usage = rec ? asRecord(rec.usage) : null
						return typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined
					})(),
					reasoningTokens: (() => {
						const rec = asRecord(final)
						const usage = rec ? asRecord(rec.usage) : null
						const details = usage ? asRecord(usage.output_tokens_details) : null
						return typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : undefined
					})()
				}
			}
		}
		// Fall back to non-streaming if we cannot get a final response.
	}

	const response = await client.responses.create({
		model: cfg.deployment,
		...(systemInstructions ? { instructions: systemInstructions } : {}),
		input: inputMessages,
		max_output_tokens: maxTokens,
		// Some Azure reasoning-model deployments reject `temperature` entirely.
		...(reasoningEffortFromEnv() !== undefined ? { reasoning: { effort: reasoningEffortFromEnv() } } : {}),
		...(textFormat ? { text: { format: textFormat } } : {})
	})

	const json = response as unknown
	if (debugEnabled()) {
		const rec = asRecord(json)
		const usage = rec ? asRecord(rec.usage) : null
		const details = usage ? asRecord(usage.output_tokens_details) : null
		debugLog("azureResponsesCompletion:ok", {
			model: rec?.model,
			status: rec?.status,
			outputTokens: usage?.output_tokens,
			reasoningTokens: details?.reasoning_tokens
		})
	}
	const text = parseResponsesOutputText(json)
	if (typeof text !== "string" || !text.trim()) {
		if (debugEnabled()) {
			const rec = asRecord(json)
			debugLog("azureResponsesCompletion:missingOutputText", {
				status: rec?.status,
				model: rec?.model,
				statusText: rec?.status
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
		model: (() => {
			const rec = asRecord(json)
			return typeof rec?.model === "string" ? rec.model : undefined
		})(),
		finishReason: (() => {
			const rec = asRecord(json)
			return typeof rec?.status === "string" ? rec.status : undefined
		})(),
		usage: {
			outputTokens: (() => {
				const rec = asRecord(json)
				const usage = rec ? asRecord(rec.usage) : null
				return typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined
			})(),
			reasoningTokens: (() => {
				const rec = asRecord(json)
				const usage = rec ? asRecord(rec.usage) : null
				const details = usage ? asRecord(usage.output_tokens_details) : null
				return typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : undefined
			})()
		}
	}
}

async function readChatCompletionsSSE(
	res: Response,
	onToken: StreamTokenHandler | undefined
): Promise<Pick<AzureChatCompletionResult, "content" | "model" | "finishReason" | "usage">> {
	if (!res.body) throw new Error("Azure OpenAI stream response missing body")
	const reader = res.body.getReader()
	const decoder = new TextDecoder("utf-8")
	let buffer = ""
	let content = ""
	let model: string | undefined
	let finishReason: string | undefined
	let usage: AzureChatCompletionUsage | undefined

	function handleEventData(data: string): boolean {
		const trimmed = data.trim()
		if (!trimmed) return false
		if (trimmed === "[DONE]") return true
		let json: unknown
		try {
			json = JSON.parse(trimmed) as unknown
		} catch {
			return false
		}
		const rec = asRecord(json)
		if (typeof rec?.model === "string") model = rec.model
		const choices = rec ? asArray(rec.choices) : null
		const choice = choices && choices.length ? asRecord(choices[0]) : null
		if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason
		// Some providers can include usage in the final chunk.
		const usageRec = rec ? asRecord(rec.usage) : null
		if (usageRec) {
			usage = {
				promptTokens: typeof usageRec.prompt_tokens === "number" ? usageRec.prompt_tokens : usage?.promptTokens,
				completionTokens:
					typeof usageRec.completion_tokens === "number"
						? usageRec.completion_tokens
						: usage?.completionTokens,
				totalTokens: typeof usageRec.total_tokens === "number" ? usageRec.total_tokens : usage?.totalTokens
			}
		}
		const delta = choice ? asRecord(choice.delta) : null
		let piece: unknown = delta?.content
		if (Array.isArray(piece)) {
			piece = piece
				.map((p) => {
					if (typeof p === "string") return p
					const pRec = asRecord(p)
					if (pRec && typeof pRec.text === "string") return pRec.text
					return ""
				})
				.join("")
		}
		if (typeof piece === "string" && piece) {
			content += piece
			onToken?.(piece)
		}
		return false
	}

	while (true) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		let idx: number
		while ((idx = buffer.indexOf("\n\n")) !== -1) {
			const rawEvent = buffer.slice(0, idx)
			buffer = buffer.slice(idx + 2)
			const lines = rawEvent.split(/\r?\n/)
			const dataLines = lines
				.map((l) => l.trimEnd())
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice("data:".length).trimStart())
			const data = dataLines.join("\n")
			if (handleEventData(data)) {
				try {
					await reader.cancel()
				} catch {
					// ignore
				}
				return { content, model, finishReason, usage }
			}
		}
	}

	return { content, model, finishReason, usage }
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
		responseFormat?: unknown
		onToken?: StreamTokenHandler
	},
	allowNoFormatRetry: boolean
): Promise<AzureChatCompletionResult> {
	if (useResponsesApiFromEnv()) {
		return await azureResponsesCompletion(cfg, params)
	}

	// Structured Outputs (response_format json_schema) requires a sufficiently new Azure API version.
	// Older api versions may silently ignore response_format and return free-form text, causing
	// downstream JSON parsing to fail intermittently.
	const rf = asRecord(params.responseFormat)
	if (rf?.type === "json_schema") {
		assertAzureApiVersionSupportsStructuredOutputs(cfg.apiVersion)
	}

	// Azure OpenAI (data-plane) Chat Completions:
	// POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
	const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(
		cfg.deployment
	)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`

	async function postJson(body: unknown): Promise<Response> {
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

	function makeBaseBody(withFormat: boolean): Record<string, unknown> {
		return {
			messages: params.messages,
			temperature: params.temperature ?? 0,
			...(params.onToken ? { stream: true } : {}),
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

	function makeBody(withFormat: boolean): Record<string, unknown> {
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

	// Streamed response: parse SSE and return buffered content.
	if (params.onToken) {
		const { content, model, finishReason, usage } = await readChatCompletionsSSE(res, params.onToken)
		if (typeof content !== "string" || !content.trim()) {
			if (allowNoFormatRetry && params.responseFormat) {
				debugLog("azureChatCompletion:streamRetryWithoutResponseFormat")
				return await azureChatCompletionInner(cfg, { ...params, responseFormat: undefined }, false)
			}
			throw new Error("Azure OpenAI streamed response missing message content")
		}
		return { content, model, finishReason, usage }
	}

	const json = (await res.json()) as unknown
	const jsonRec = asRecord(json)
	const choices = jsonRec ? asArray(jsonRec.choices) : null
	const choice = choices && choices.length ? asRecord(choices[0]) : null
	const message = choice ? asRecord(choice.message) : null

	let content: unknown = message?.content
	if (Array.isArray(content)) {
		// Some providers/models return an array of content parts.
		content = content
			.map((p) => {
				if (typeof p === "string") return p
				const pRec = asRecord(p)
				if (pRec && typeof pRec.text === "string") return pRec.text
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
		if (message && message.tool_calls != null) {
			throw new Error("Azure OpenAI response requested tool calls (no message content)")
		}
		if (allowNoFormatRetry && params.responseFormat) {
			debugLog("azureChatCompletion:retryWithoutResponseFormat")
			return await azureChatCompletionInner(cfg, { ...params, responseFormat: undefined }, false)
		}

		// GPT-5.x deployments can behave poorly on chat-completions (empty content + reasoning only).
		// As a best-effort fallback, try the v1 Responses API once.
		const model = typeof jsonRec?.model === "string" ? jsonRec.model : ""
		if (model.startsWith("gpt-5") || model.startsWith("gpt-5.")) {
			debugLog("azureChatCompletion:fallbackToResponses", { model })
			return await azureResponsesCompletion(cfg, params)
		}

		const finish = typeof choice?.finish_reason === "string" ? ` (finish_reason=${choice.finish_reason})` : ""
		throw new Error(`Azure OpenAI response missing message content${finish}`)
	}

	return {
		content,
		model: typeof jsonRec?.model === "string" ? jsonRec.model : undefined,
		finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
		usage: {
			promptTokens: (() => {
				const usage = jsonRec ? asRecord(jsonRec.usage) : null
				return typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
			})(),
			completionTokens: (() => {
				const usage = jsonRec ? asRecord(jsonRec.usage) : null
				return typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined
			})(),
			totalTokens: (() => {
				const usage = jsonRec ? asRecord(jsonRec.usage) : null
				return typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined
			})()
		}
	}
}

export async function azureChatCompletion(
	cfg: AzureOpenAIConfig,
	params: {
		messages: ChatMessage[]
		temperature?: number
		maxTokens?: number
		responseFormat?: unknown
		onToken?: StreamTokenHandler
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
		responseFormat?: unknown
		onToken?: StreamTokenHandler
	}
): Promise<AzureChatCompletionResult> {
	return await azureChatCompletionInner(cfg, params, true)
}
