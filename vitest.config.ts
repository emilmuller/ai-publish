import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		// Windows + forked workers can be flaky/slow; threads are more reliable here.
		pool: "threads",
		maxThreads: 2,
		minThreads: 1,
		testTimeout: 20000,
		include: ["test/**/*.test.ts"]
	}
})
