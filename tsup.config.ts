import { defineConfig, type Format } from "tsup"

const shared = {
	format: ["cjs", "esm"] as Format[],
	platform: "node" as const,
	target: "node18",
	splitting: false,
	sourcemap: true,
	minify: false,
	outDir: "dist",
	outExtension({ format }: { format: Format }) {
		return {
			js: format === "esm" ? ".mjs" : ".js"
		}
	}
}

export default defineConfig([
	{
		...shared,
		entry: {
			index: "src/index.ts"
		},
		clean: true,
		dts: true
	},
	{
		...shared,
		format: ["cjs"],
		entry: {
			cli: "src/cli.ts"
		},
		clean: false,
		dts: false,
		banner: {
			js: "#!/usr/bin/env node"
		}
	}
])
