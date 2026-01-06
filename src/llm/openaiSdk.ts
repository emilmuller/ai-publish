type OpenAIModule = any

let importPromise: Promise<OpenAIModule> | null = null

function importESM(moduleName: string): Promise<any> {
	// TS compiled to CJS will rewrite `import()` to `require()` in some configurations.
	// Using `new Function` preserves a real dynamic ESM import at runtime.
	const importer = new Function("m", "return import(m)") as (m: string) => Promise<any>
	return importer(moduleName)
}

export async function importOpenAI(): Promise<OpenAIModule> {
	if (!importPromise) importPromise = importESM("openai")
	return await importPromise
}

type AzureClientKey = string
type OpenAIClientKey = string

const azureClientCache = new Map<AzureClientKey, any>()
const openAIClientCache = new Map<OpenAIClientKey, any>()

export async function getAzureOpenAIClient(params: {
	endpoint: string
	apiKey: string
	apiVersion: string
	requestTimeoutMs: number
	maxRetries?: number
}): Promise<any> {
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
	if (!AzureOpenAI) throw new Error("OpenAI SDK missing AzureOpenAI export")

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
}): Promise<any> {
	const key = [params.baseUrl ?? "", params.apiKey, params.requestTimeoutMs, params.maxRetries ?? 2].join("|")
	const existing = openAIClientCache.get(key)
	if (existing) return existing

	const mod = await importOpenAI()
	const OpenAI = mod.OpenAI ?? mod.default
	if (!OpenAI) throw new Error("OpenAI SDK missing OpenAI export")

	const client = new OpenAI({
		apiKey: params.apiKey,
		...(params.baseUrl ? { baseURL: params.baseUrl } : {}),
		timeout: params.requestTimeoutMs,
		maxRetries: params.maxRetries ?? 2
	})

	openAIClientCache.set(key, client)
	return client
}
