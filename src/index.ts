export * from "./diff"
export { classifyFile } from "./classify/classifyFile"
export { detectBreakingChanges } from "./changelog/breaking"
export { validateChangelogModel } from "./changelog/validate"
export { getResolvedInstructions, resolveInstructions } from "./instructions/resolveInstructions"
export type { ResolvedInstructions, InstructionFile } from "./instructions/types"
export { runChangelogPipeline } from "./pipeline/runChangelogPipeline"
export { runReleaseNotesPipeline } from "./pipeline/runReleaseNotesPipeline"
export { runVersionBumpPipeline } from "./pipeline/runVersionBumpPipeline"
export { runPrepublishPipeline } from "./pipeline/runPrepublishPipeline"
export { runPostpublishPipeline } from "./pipeline/runPostpublishPipeline"
export type { PublishRunner } from "./pipeline/runPostpublishPipeline"
export type { ManifestTarget, ManifestType } from "./version/manifests"
export type { LLMClient } from "./llm/types"
export { createAzureOpenAILLMClient } from "./llm/azureOpenAI"
export { createOpenAILLMClient } from "./llm/openAI"
export { buildEvidenceFromManifest } from "./changelog/evidence"

export { resolveVersionBaseFromGitTags } from "./version/resolveVersionBase"
export { resolveHeadVersionTagFromGitTags } from "./version/resolveVersionBase"
export { computeBumpTypeFromChangelogModel, computeNextVersion } from "./version/bump"

export { generateChangelog, generateReleaseNotes, prepublish, postpublish } from "./programmatic"
export type {
	CommonGenerateArgs,
	GenerateChangelogArgs,
	GenerateChangelogResult,
	GenerateReleaseNotesResult,
	PrepublishArgs,
	PrepublishResult,
	PostpublishArgs,
	PostpublishResult
} from "./programmatic"
