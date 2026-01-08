type OpenAIModule = Record<string, unknown>

let importPromise: Promise<OpenAIModule> | null = null

function asRecord(v: unknown): Record<string, unknown> | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null
	return v as Record<string, unknown>
}

type UnknownConstructor<T> = new (...args: unknown[]) => T

function isConstructor<T>(v: unknown): v is UnknownConstructor<T> {
	return typeof v === "function"
}

export type OpenAIResponseStream = AsyncIterable<unknown> & {
	close?: () => void
	finalResponse?: () => Promise<unknown>
}

export type OpenAIResponsesResource = {
	create: (args: unknown) => Promise<unknown>
	stream?: (args: unknown) => OpenAIResponseStream
}

export type OpenAIClient = {
	responses: OpenAIResponsesResource
}

export type AzureOpenAIClient = {
	responses: OpenAIResponsesResource
}

function importESM(moduleName: string): Promise<unknown> {
	// TS compiled to CJS will rewrite `import()` to `require()` in some configurations.
	// Using `new Function` preserves a real dynamic ESM import at runtime.
	const importer = new Function("m", "return import(m)") as (m: string) => Promise<unknown>
	return importer(moduleName)
}

export async function importOpenAI(): Promise<OpenAIModule> {
	if (!importPromise) {
		importPromise = importESM("openai").then((m) => {
			const rec = asRecord(m)
			if (!rec) throw new Error("OpenAI SDK import did not return a module object")
			return rec
		})
	}
	return await importPromise
}

type AzureClientKey = string
type OpenAIClientKey = string

const azureClientCache = new Map<AzureClientKey, AzureOpenAIClient>()
const openAIClientCache = new Map<OpenAIClientKey, OpenAIClient>()

export async function getAzureOpenAIClient(params: {
	endpoint: string
	apiKey: string
	apiVersion: string
	requestTimeoutMs: number
	maxRetries?: number
}): Promise<AzureOpenAIClient> {
	const key = [
		params.endpoint,
		params.apiVersion,
		params.apiKey,
		params.requestTimeoutMs,
		params.maxRetries ?? 2
	].join("|")
	const existing = azureClientCache.get(key)
	if (existing) return existing

	const mod = await importOpenAI()
	const AzureOpenAI = mod.AzureOpenAI
	if (!isConstructor<AzureOpenAIClient>(AzureOpenAI)) throw new Error("OpenAI SDK missing AzureOpenAI export")

	const client = new AzureOpenAI({
		endpoint: params.endpoint,
		apiKey: params.apiKey,
		apiVersion: params.apiVersion,
		timeout: params.requestTimeoutMs,
		maxRetries: params.maxRetries ?? 2
	})

	azureClientCache.set(key, client)
	return client
}

export async function getOpenAIClient(params: {
	baseUrl?: string
	apiKey: string
	requestTimeoutMs: number
	maxRetries?: number
}): Promise<OpenAIClient> {
	const key = [params.baseUrl ?? "", params.apiKey, params.requestTimeoutMs, params.maxRetries ?? 2].join("|")
	const existing = openAIClientCache.get(key)
	if (existing) return existing

	const mod = await importOpenAI()
	const OpenAI = mod.OpenAI ?? mod.default
	if (!isConstructor<OpenAIClient>(OpenAI)) throw new Error("OpenAI SDK missing OpenAI export")

	const client = new OpenAI({
		apiKey: params.apiKey,
		...(params.baseUrl ? { baseURL: params.baseUrl } : {}),
		timeout: params.requestTimeoutMs,
		maxRetries: params.maxRetries ?? 2
	})

	openAIClientCache.set(key, client)
	return client
}
