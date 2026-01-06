import type { EvidenceNode } from "../src/changelog/types"
import { compareStrings } from "../src/util/compare"

export type AzureOpenAIConfig = {
	endpoint: string
	apiKey: string
	deployment: string
	apiVersion: string
	timeoutMs: number
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type LlmEvalResult = { accepted: boolean; reason: string | null }

export function isTruthyEnv(v: string | undefined): boolean {
	return !!(v && v.trim() && v !== "0" && v.toLowerCase() !== "false")
}

function requiredEnvOrMissing(name: string): string | undefined {
	const v = process.env[name]
	return v && v.trim() ? v : undefined
}

export function getAzureConfigForEval(): { ok: true; cfg: AzureOpenAIConfig } | { ok: false; missing: string[] } {
	const endpoint = requiredEnvOrMissing("AZURE_OPENAI_ENDPOINT")
	const apiKey = requiredEnvOrMissing("AZURE_OPENAI_API_KEY")
	const deployment = requiredEnvOrMissing("AZURE_OPENAI_DEPLOYMENT")
	const apiVersion = requiredEnvOrMissing("AZURE_OPENAI_API_VERSION") ?? "2024-08-01-preview"
	const timeoutMs = Number(requiredEnvOrMissing("AZURE_OPENAI_TIMEOUT_MS") ?? "60000")

	const missing = [
		!endpoint ? "AZURE_OPENAI_ENDPOINT" : "",
		!apiKey ? "AZURE_OPENAI_API_KEY" : "",
		!deployment ? "AZURE_OPENAI_DEPLOYMENT" : ""
	].filter(Boolean)

	if (missing.length) return { ok: false, missing }
	return {
		ok: true,
		cfg: {
			endpoint: endpoint!.replace(/\/$/, ""),
			apiKey: apiKey!,
			deployment: deployment!,
			apiVersion,
			timeoutMs
		}
	}
}

function stripCodeFences(text: string): string {
	const t = text.trim()
	const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
	return m ? m[1].trim() : t
}

export function parseEvalJson(text: string): LlmEvalResult {
	const raw = stripCodeFences(text)
	let obj: unknown
	try {
		obj = JSON.parse(raw)
	} catch {
		throw new Error(`Expected JSON eval output, got: ${raw.slice(0, 400)}`)
	}
	if (!obj || typeof obj !== "object") throw new Error("Eval output must be a JSON object")
	const anyObj = obj as any
	if (typeof anyObj.accepted !== "boolean") throw new Error("Eval output.accepted must be boolean")
	if (!(anyObj.reason === null || typeof anyObj.reason === "string")) {
		throw new Error("Eval output.reason must be string|null")
	}
	return { accepted: anyObj.accepted, reason: anyObj.reason }
}

function jsonSchemaResponseFormat(name: string, schema: unknown): any {
	return {
		type: "json_schema",
		json_schema: {
			name,
			strict: true,
			schema
		}
	}
}

const schemaEvalVerdict = {
	type: "object",
	additionalProperties: false,
	properties: {
		accepted: { type: "boolean" },
		reason: { anyOf: [{ type: "string" }, { type: "null" }] }
	},
	required: ["accepted", "reason"]
} as const

export async function azureChatCompletion(cfg: AzureOpenAIConfig, messages: ChatMessage[]): Promise<string> {
	const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(
		cfg.deployment
	)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`

	const ctrl = new AbortController()
	const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
	async function post(body: any): Promise<Response> {
		return await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": cfg.apiKey
			},
			body: JSON.stringify(body),
			signal: ctrl.signal
		})
	}

	try {
		const baseBody = {
			messages,
			temperature: 0,
			response_format: jsonSchemaResponseFormat("llm_eval_verdict", schemaEvalVerdict)
		}
		let res = await post({ ...baseBody, max_completion_tokens: 900 })
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			const msg = text || res.statusText
			const looksLikeUnsupportedResponseFormat =
				res.status === 400 && /response_format|json_schema|structured/i.test(msg)
			const looksLikeUnsupportedMaxCompletion =
				res.status === 400 && /max_completion_tokens/i.test(msg) && /unsupported/i.test(msg)
			if (looksLikeUnsupportedResponseFormat) {
				throw new Error(
					`Azure OpenAI eval request rejected Structured Outputs (response_format). ` +
						`Set AZURE_OPENAI_API_VERSION to 2024-08-01-preview or later (current: ${cfg.apiVersion}). ` +
						`Raw error: ${msg}`
				)
			}
			if (looksLikeUnsupportedMaxCompletion) {
				res = await post({ ...baseBody, max_tokens: 900 })
			}
			if (!res.ok) {
				throw new Error(`Azure OpenAI request failed (${res.status}): ${msg}`)
			}
		}

		const json = (await res.json()) as any
		const content = json?.choices?.[0]?.message?.content
		if (typeof content !== "string" || !content.trim()) {
			throw new Error("Azure OpenAI response missing message content")
		}
		return content
	} finally {
		clearTimeout(t)
	}
}

export function formatEvidenceIndex(evidence: Record<string, EvidenceNode>): string {
	const ids = Object.keys(evidence).sort(compareStrings)
	return ids
		.map((id) => {
			const e = evidence[id]!
			return [
				`id: ${e.id}`,
				`file: ${e.filePath}`,
				e.oldPath ? `oldFile: ${e.oldPath}` : "",
				`type: ${e.changeType}`,
				`surface: ${e.surface}`,
				`binary: ${e.isBinary ? "yes" : "no"}`,
				`hunks: ${e.hunkIds.join(",")}`
			]
				.filter(Boolean)
				.join(" | ")
		})
		.join("\n")
}

export function formatHunks(hunks: Array<{ id: string; filePath: string; header: string; lines: string[] }>): string {
	return hunks
		.sort((a, b) => compareStrings(a.filePath, b.filePath) || compareStrings(a.id, b.id))
		.map((h) => {
			return [`--- hunk ${h.id}`, `file: ${h.filePath}`, `header: ${h.header}`, "lines:", ...h.lines].join("\n")
		})
		.join("\n\n")
}
