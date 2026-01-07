export type LogLevel = "silent" | "info" | "debug" | "trace"

type LogConfig = {
	level: LogLevel
	traceTools: boolean
	traceLLM: boolean
	traceLLMOutput: boolean
}

let isCliProcess = process.env.AI_PUBLISH_IS_CLI === "1"

export function markCliProcess(): void {
	isCliProcess = true
}

function parseLogLevel(raw: string | undefined): LogLevel | null {
	const v = (raw ?? "").trim().toLowerCase()
	if (!v) return null
	if (v === "silent" || v === "none" || v === "off") return "silent"
	if (v === "info") return "info"
	if (v === "debug") return "debug"
	if (v === "trace") return "trace"
	return null
}

function getConfig(): LogConfig {
	const configured = parseLogLevel(process.env.AI_PUBLISH_LOG_LEVEL)
	const level: LogLevel = configured ?? (isCliProcess ? "info" : "silent")
	const traceLLMOutputRaw = process.env.AI_PUBLISH_TRACE_LLM_OUTPUT
	return {
		level,
		traceTools: process.env.AI_PUBLISH_TRACE_TOOLS === "1",
		traceLLM: process.env.AI_PUBLISH_TRACE_LLM === "1",
		// Default-on for the CLI so local runs are transparent without extra flags.
		// Still logs only to stderr to keep stdout machine-readable.
		traceLLMOutput: traceLLMOutputRaw === "1" || (traceLLMOutputRaw === undefined && isCliProcess)
	}
}

function levelRank(level: LogLevel): number {
	if (level === "silent") return 0
	if (level === "info") return 1
	if (level === "debug") return 2
	return 3
}

function safeJson(value: unknown, maxChars: number): string {
	try {
		const s = JSON.stringify(value)
		if (s.length <= maxChars) return s
		return s.slice(0, Math.max(0, maxChars - 20)) + "…(truncated)"
	} catch {
		return '{"error":"unserializable"}'
	}
}

function emit(kind: "info" | "debug" | "trace", event: string, data?: unknown): void {
	const cfg = getConfig()
	if (levelRank(cfg.level) < levelRank(kind as LogLevel)) return
	const suffix = data === undefined ? "" : " " + safeJson(data, 16_000)
	// IMPORTANT: always log to stderr so stdout JSON remains parseable in pipelines.
	// eslint-disable-next-line no-console
	console.error(`[ai-publish][${kind}] ${event}${suffix}`)
}

export function logInfo(event: string, data?: unknown): void {
	emit("info", event, data)
}

export function logDebug(event: string, data?: unknown): void {
	emit("debug", event, data)
}

export function logTrace(event: string, data?: unknown): void {
	emit("trace", event, data)
}

export function traceToolsEnabled(): boolean {
	return getConfig().traceTools
}

export function traceLLMEnabled(): boolean {
	return getConfig().traceLLM
}

export function traceLLMOutputEnabled(): boolean {
	return getConfig().traceLLMOutput
}

export function logLLMOutput(event: string, content: string, opts?: { maxChars?: number }): void {
	if (!traceLLMOutputEnabled()) return
	const maxChars = opts?.maxChars ?? 24_000
	const s = content ?? ""
	const shown = s.length <= maxChars ? s : s.slice(0, Math.max(0, maxChars - 20)) + "\n…(truncated)"
	// eslint-disable-next-line no-console
	console.error(`[ai-publish][llm-output] ${event}\n${shown}`)
}
