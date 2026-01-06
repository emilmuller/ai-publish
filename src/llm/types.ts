import type { DiffHunk, DiffIndexManifest, DiffSummary } from "../diff/types"
import type { ResolvedInstructions } from "../instructions/types"
import type { ChangelogModel } from "../changelog/types"
import type { EvidenceNode } from "../changelog/types"
import type {
	RepoFileSnippet,
	RepoFileSnippetRequest,
	RepoSnippetAroundRequest,
	RepoSnippetAroundResult,
	RepoFileSearchRequest,
	RepoFileSearchResult,
	RepoFileListRequest,
	RepoFileListResult,
	RepoPathSearchRequest,
	RepoPathSearchResult,
	RepoFileMetaRequest,
	RepoFileMetaResult,
	RepoTextSearchRequest,
	RepoTextSearchResult
} from "../repo/types"

export type MechanicalPassInput = {
	base: string
	diffSummary: DiffSummary
	diffIndexManifest: DiffIndexManifest
	evidence: Record<string, EvidenceNode>
	resolvedInstructions: ResolvedInstructions[]
	deterministicFacts: string[]
}

export type MechanicalPassOutput = {
	// Deterministic intermediate representation of what changed (no semantics).
	notes: string[]
}

export type SemanticPassInput = {
	base: string
	mechanical: MechanicalPassOutput
	evidence: Record<string, EvidenceNode>
	resolvedInstructions: ResolvedInstructions[]
}

export type SemanticTools = {
	getDiffHunks: (hunkIds: string[]) => Promise<DiffHunk[]>
	getRepoFileSnippets: (requests: RepoFileSnippetRequest[]) => Promise<RepoFileSnippet[]>
	getRepoSnippetAround: (requests: RepoSnippetAroundRequest[]) => Promise<RepoSnippetAroundResult[]>
	getRepoFileMeta: (requests: RepoFileMetaRequest[]) => Promise<RepoFileMetaResult[]>
	searchRepoFiles: (requests: RepoFileSearchRequest[]) => Promise<RepoFileSearchResult[]>
	searchRepoPaths: (requests: RepoPathSearchRequest[]) => Promise<RepoPathSearchResult[]>
	searchRepoText: (requests: RepoTextSearchRequest[]) => Promise<RepoTextSearchResult[]>
	listRepoFiles: (requests: RepoFileListRequest[]) => Promise<RepoFileListResult[]>
}

export type SemanticPassOutput = {
	// Evidence-backed impact statements (still not editorialized).
	notes: string[]
}

export type EditorialPassInput = {
	mechanical: MechanicalPassOutput
	semantic: SemanticPassOutput
	evidence: Record<string, EvidenceNode>
	resolvedInstructions: ResolvedInstructions[]
}

export type ReleaseNotesOutput = {
	// Human-facing Markdown release notes.
	markdown: string
	// Evidence node IDs that support the release notes content.
	evidenceNodeIds: string[]
}

export type VersionBumpInput = {
	previousVersion: string
	bumpType: "major" | "minor" | "patch" | "none"
	nextVersion: string
	changelogModel: ChangelogModel
}

export type VersionBumpOutput = {
	nextVersion: string
	justification: string
}

export interface LLMClient {
	pass1Mechanical(input: MechanicalPassInput): Promise<MechanicalPassOutput>
	pass2Semantic(input: SemanticPassInput, tools: SemanticTools): Promise<SemanticPassOutput>
	pass3Editorial(input: EditorialPassInput): Promise<ChangelogModel>
	pass3ReleaseNotes(input: EditorialPassInput): Promise<ReleaseNotesOutput>
	pass3VersionBump(input: VersionBumpInput): Promise<VersionBumpOutput>
}
