# Changelog
## [3.0.0] - 2026-01-13

### Added
- Added a way to run a custom publish command during postpublish.

### Changed
- **BREAKING:** Programmatic postpublish options now validate that you can’t set both a custom publish command and “skip publish” at the same time.
- .NET NuGet publishing now uses default NuGet configuration unless a source is explicitly provided via environment variables.
- .NET postpublish now prefers pushing the package that matches the intended release version when available.
- Postpublish now chooses the publish step more flexibly: it can use an injected runner, skip publishing, run a provided command, or fall back to the default publish behavior.
- Performance and stability improvements.
## [2.1.0] - 2026-01-08

### Added
- Expose an ES module build alongside the existing CommonJS entry, enabling native ESM imports in modern tooling.
- Introduce Node.js version metadata and linting/build configuration to standardize local development and packaging.

### Changed
- Refine CLI behavior and logging to provide clearer output and more reliable automation flows.
- Refresh documentation and agent guidance to better explain setup, usage, and release behavior.
- Tighten instruction resolution and breaking-change detection to better respect per-file rules and highlight impactful changes.
- Enhance diff processing and commit context handling to generate more precise change descriptions from Git history.
- Improve LLM client handling for both OpenAI and Azure OpenAI backends to increase reliability and response handling quality.
- Improve changelog, release-notes, and prepublish pipelines for more accurate summaries and smoother release automation.
- Refine programmatic and Python integration paths to make it easier to embed the tool in custom workflows.
- Update language-specific version detection for .NET, npm, Python, Rust, and Go to make version bumps more robust across ecosystems.
- Update dependencies and lockfile to align with the new build and linting setup.
## [2.0.0] - 2026-01-07

### Changed

- **BREAKING:** Renamed the npm publish script to release, which may require updating any automation or documentation that calls the old script name.
- Updated documentation to reflect the new release script name and usage.

## [1.2.0] - 2026-01-07

### Added

- Include the changelog file in the published npm package so release notes are available to consumers.
- Document the multi-pass AI workflow and deterministic versioning behavior for easier integration and debugging.

### Changed

- Align the command-line interface with the new tag-aware base selection so changelog and release-notes output consistently compare against the previous version when the current commit is tagged.
- Consolidate the publish workflow into a single script that builds and then runs pre- and post-publish steps in sequence for a more reliable release process.
- Improve changelog rendering so that when all internal-only bullets are hidden, a generic performance and stability note is shown instead of leaving sections blank.
- Update the programmatic APIs for generating changelogs and release notes to use the same tag-aware base resolution as the CLI when no explicit base is provided.
- Refine how the base commit is chosen for versioning so that when the current commit is already tagged, the previous reachable version tag is used as the comparison point.
- Clarify internal guidance for AI agents on evidence handling, multi-pass processing, and version bump rules to reduce operational errors.

## [1.1.1] - 2026-01-07

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
