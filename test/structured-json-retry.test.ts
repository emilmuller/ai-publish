import { describe, expect, it } from "vitest"

import { shouldRetryStructuredJsonParse } from "../src/llm/azureOpenAI/parseAndCoerce"

describe("structured JSON retry detection", () => {
	it("retries when finishReason indicates output length stop", () => {
		expect(shouldRetryStructuredJsonParse('{"notes":["a"]}', "length")).toBe(true)
		expect(shouldRetryStructuredJsonParse('{"notes":["a"]}', "max_output_tokens")).toBe(true)
	})

	it("retries when JSON starts but is unterminated and finishReason is missing", () => {
		expect(shouldRetryStructuredJsonParse('{"notes":["a","b"', undefined)).toBe(true)
		expect(shouldRetryStructuredJsonParse('```json\n{"notes":["a"\n```', null)).toBe(true)
	})

	it("does not retry balanced malformed JSON without a truncation signal", () => {
		expect(shouldRetryStructuredJsonParse('{"notes":[1,]}', undefined)).toBe(false)
	})

	it("does not retry non-JSON output without a truncation signal", () => {
		expect(shouldRetryStructuredJsonParse("sorry, I cannot comply", undefined)).toBe(false)
	})
})
