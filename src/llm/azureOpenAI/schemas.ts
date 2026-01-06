export function jsonSchemaResponseFormat(name: string, schema: unknown): any {
	return {
		type: "json_schema",
		json_schema: {
			name,
			strict: true,
			schema
		}
	}
}

export const schemaNotesOutput = {
	type: "object",
	additionalProperties: false,
	required: ["notes"],
	properties: {
		notes: {
			type: "array",
			items: { type: "string" }
		}
	}
} as const

export const schemaSemanticRequest = {
	type: "object",
	additionalProperties: false,
	required: [
		"requestHunkIds",
		"requestFileSnippets",
		"requestSnippetsAround",
		"requestFileSearches",
		"requestRepoSearches",
		"requestRepoPathSearches",
		"requestRepoFileLists",
		"requestRepoFileMeta",
		"done"
	],
	properties: {
		requestHunkIds: {
			type: "array",
			items: { type: "string" }
		},
		requestFileSnippets: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "startLine", "endLine"],
				properties: {
					path: { type: "string" },
					startLine: { type: "integer" },
					endLine: { type: "integer" }
				}
			}
		},
		requestSnippetsAround: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "lineNumber", "contextLines"],
				properties: {
					path: { type: "string" },
					lineNumber: { type: "integer" },
					contextLines: { anyOf: [{ type: "integer" }, { type: "null" }] }
				}
			}
		},
		requestFileSearches: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path", "query", "ignoreCase", "maxResults"],
				properties: {
					path: { type: "string" },
					query: { type: "string" },
					ignoreCase: { anyOf: [{ type: "boolean" }, { type: "null" }] },
					maxResults: { anyOf: [{ type: "integer" }, { type: "null" }] }
				}
			}
		},
		requestRepoSearches: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["query", "ignoreCase", "pathPrefix", "fileExtensions", "maxResults", "maxFiles"],
				properties: {
					query: { type: "string" },
					ignoreCase: { anyOf: [{ type: "boolean" }, { type: "null" }] },
					pathPrefix: { anyOf: [{ type: "string" }, { type: "null" }] },
					fileExtensions: {
						anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }]
					},
					maxResults: { anyOf: [{ type: "integer" }, { type: "null" }] },
					maxFiles: { anyOf: [{ type: "integer" }, { type: "null" }] }
				}
			}
		},
		requestRepoPathSearches: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["query", "ignoreCase", "pathPrefix", "fileExtensions", "maxFiles"],
				properties: {
					query: { type: "string" },
					ignoreCase: { anyOf: [{ type: "boolean" }, { type: "null" }] },
					pathPrefix: { anyOf: [{ type: "string" }, { type: "null" }] },
					fileExtensions: {
						anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }]
					},
					maxFiles: { anyOf: [{ type: "integer" }, { type: "null" }] }
				}
			}
		},
		requestRepoFileLists: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["pathPrefix", "fileExtensions", "maxFiles"],
				properties: {
					pathPrefix: { anyOf: [{ type: "string" }, { type: "null" }] },
					fileExtensions: {
						anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }]
					},
					maxFiles: { anyOf: [{ type: "integer" }, { type: "null" }] }
				}
			}
		},
		requestRepoFileMeta: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["path"],
				properties: {
					path: { type: "string" }
				}
			}
		},
		done: { type: "boolean" }
	}
} as const

export const schemaChangelogModel = {
	type: "object",
	additionalProperties: false,
	required: ["breakingChanges", "added", "changed", "fixed", "removed", "internalTooling"],
	properties: {
		breakingChanges: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		},
		added: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		},
		changed: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		},
		fixed: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		},
		removed: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		},
		internalTooling: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidenceNodeIds"],
				properties: {
					text: { type: "string" },
					evidenceNodeIds: { type: "array", items: { type: "string" } }
				}
			}
		}
	}
} as const

export const schemaReleaseNotesOutput = {
	type: "object",
	additionalProperties: false,
	required: ["markdown", "evidenceNodeIds"],
	properties: {
		markdown: { type: "string" },
		evidenceNodeIds: { type: "array", items: { type: "string" } }
	}
} as const

export const schemaVersionBumpOutput = {
	type: "object",
	additionalProperties: false,
	required: ["nextVersion", "justification"],
	properties: {
		nextVersion: { type: "string" },
		justification: { type: "string" }
	}
} as const
