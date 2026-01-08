import { defineConfig } from "tsup"

const shared = {
	format: ["cjs", "esm"],
	platform: "node" as const,
	target: "node18",
	splitting: false,
	sourcemap: true,
	minify: false,
	outDir: "dist",
	outExtension({ format }: { format: "cjs" | "esm" }) {
		return {
			js: format === "esm" ? ".mjs" : ".js"
		}
	}
}

export default defineConfig([
	{
		...shared,
		entry: {
			index: "src/index.ts",
			cli: "src/cli.ts"
		},
		clean: true,
		dts: true
	},
	{
		...shared,
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
