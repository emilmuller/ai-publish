import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 20000,
		include: ["test/**/*.test.ts"]
	}
})
