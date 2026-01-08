import { defineConfig } from "tsup"

export default defineConfig({
	entry: {
		index: "src/index.ts",
		cli: "src/cli.ts"
	},
	format: ["cjs", "esm"],
	platform: "node",
	target: "node18",
	splitting: false,
	sourcemap: true,
	clean: true,
	minify: false,
	outDir: "dist",
	dts: true,
	banner: {
		js: "#!/usr/bin/env node"
	},
	outExtension({ format }) {
		return {
			js: format === "esm" ? ".mjs" : ".js"
		}
	}
})
