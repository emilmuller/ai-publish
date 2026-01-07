# Changelog
## [1.1.0] - 2026-01-07

### Added
- Introduced shared hunk-budget helper `fetchHunksWithBudget` to chunk `getDiffHunks` calls and skip oversize hunks without failing runs.

### Changed
- Updated changelog pipeline to use shared hunk-budget helper and shared `remainingBytes` state.
- Updated release-notes pipeline to share the same hunk-budgeting behavior via `fetchHunksWithBudget`.
- Canonicalized release-notes section order and limited output to a fixed set of allowed sections while keeping the public API.
- Made release-notes bullet lists deterministically sorted within each section, including synthesized bodies.
- Adjusted Vitest worker configuration to use a small threads-based pool on Windows.
## [1.0.0] - 2026-01-07

### Added
- Added a Keep a Changelog–style renderer that normalizes versions and filters out internal-only changes.
- Implemented a release-notes renderer that curates sections, normalizes version labels, and extracts summaries.
- Introduced a centralized logging utility with environment-driven log levels and dedicated LLM tracing helpers.

### Changed
- **BREAKING:** Changed CLI and pipeline behavior for prepublish and release-notes generation, which may impact existing automation workflows.
- **BREAKING:** Adjusted LLM client and type definitions, which may affect consumers relying on the programmatic LLM API surface.
- Improved documentation for agents, usage, and new pipelines in AGENTS.md and README.md.
- Refined changelog prepending logic and tests to better integrate with the new renderer and pipelines.
- Updated prepublish and release-notes pipelines to use the new renderers and commit context, with expanded test coverage.
- Enhanced Azure OpenAI client, HTTP, config, parsing, and prompt handling, plus OpenAI client behavior, with updated tests.
## [0.1.0]

- Add high-level programmatic API entrypoints for generating changelogs, release notes, and running pipelines.
- Add pipeline orchestration for changelog generation, release notes, version bumping, prepublish, and postpublish workflows.
- Initialize the `ai-publish` npm package with public API exports and a CLI binary entrypoint.
- Introduce an extensive automated test suite covering CLI, changelog, LLM, repo, manifest, and pipeline behavior.
- Document the project with README, agent guidelines, license, and supporting configuration files.
- Add core changelog, diff, evidence, and instruction-resolution modules and re-export them from the public API.
- Implement language-specific runners for npm, .NET, Python, and Rust plus git helpers for release automation.
- Introduce LLM integration layer for OpenAI and Azure OpenAI with shared schemas, HTTP clients, and deterministic test helpers.
- Add repository inspection and search utilities for listing files, reading snippets, and searching paths and text.
- Add foundational utilities for file I/O, comparison, and SHA-256 hashing used across the toolchain.
- Introduce version management utilities and manifest updaters for npm, Python, Rust, Go, and .NET projects.
- Set up TypeScript build, Vitest configuration, and VS Code build task for the project.
- Add gitignore and npm lockfile to stabilize development and installation environments.
- Added src/changelog/types.ts.
- Added src/classify/classifyFile.ts.
