import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

describe("logger defaults", () => {
	const originalEnv = process.env

	beforeEach(() => {
		vi.resetModules()
		process.env = { ...originalEnv }
		delete process.env.AI_PUBLISH_TRACE_LLM_OUTPUT
		delete process.env.AI_PUBLISH_TRACE_LLM
		delete process.env.AI_PUBLISH_LOG_LEVEL
	})

	afterEach(() => {
		process.env = originalEnv
		vi.restoreAllMocks()
	})

	it("does not enable LLM output tracing for non-CLI by default", async () => {
		const logger = await import("../src/util/logger")
		expect(logger.traceLLMOutputEnabled()).toBe(false)
	})

	it("enables LLM output tracing by default for CLI processes", async () => {
		const logger = await import("../src/util/logger")
		logger.markCliProcess()
		expect(logger.traceLLMOutputEnabled()).toBe(true)
	})

	it("allows explicitly disabling LLM output tracing via env", async () => {
		process.env.AI_PUBLISH_TRACE_LLM_OUTPUT = "0"
		const logger = await import("../src/util/logger")
		logger.markCliProcess()
		expect(logger.traceLLMOutputEnabled()).toBe(false)
	})
})
