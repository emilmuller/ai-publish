import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true })
}

export async function writeFileAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
	await ensureDir(dirname(filePath))
	const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
	await writeFile(tmpPath, content)
	await rename(tmpPath, filePath)
}
