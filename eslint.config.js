const js = require("@eslint/js")
const tsParser = require("@typescript-eslint/parser")
const tsPlugin = require("@typescript-eslint/eslint-plugin")

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
	{
		ignores: ["dist/**", "node_modules/**", ".ai-publish/**"]
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module"
			}
		},
		plugins: {
			"@typescript-eslint": tsPlugin
		},
		rules: {
			...js.configs.recommended.rules,

			// TypeScript-aware equivalents
			"no-unused-vars": "off",
			"no-undef": "off",

			// Stricter defaults (keep repo warning-free)
			"no-control-regex": "error",
			"no-useless-escape": "error",
			"no-constant-condition": "error",
			"no-extra-semi": "error",

			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/prefer-as-const": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }
			]
		}
	}
]
