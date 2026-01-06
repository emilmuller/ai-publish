# Changelog (4b825dc642cb6eb9a060e54bf8d69288fbee4904..v0.1.0)

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