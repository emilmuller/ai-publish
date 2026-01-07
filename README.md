# ai-publish — Ready to let AI write your release notes, changelog, and compute your next semver bump?

ai-publish is built to do that _without_ letting the model invent changes: the only authority for “what changed” is `git diff <base>..HEAD`. The system may still use additional **bounded context** (e.g. file snippets, searches, and optional commit-message metadata) to understand more.

## Primary workflow: `prepublish` → `postpublish`

Most users should use ai-publish as a two-step release flow:

1. `prepublish` prepares release outputs (and the next version) locally.
2. You build/package your artifacts.
3. `postpublish` publishes, then finalizes git state (commit + tag + push).

Install as a dev dependency (recommended):

```bash
npm install --save-dev ai-publish
```

### Required: configure an LLM provider

ai-publish requires an LLM provider for `prepublish`, `changelog`, and `release-notes`.

Before running the CLI, choose a provider (`openai` or `azure`) and set the required environment variables (see the “LLM providers” section below).

Most users start with OpenAI:

-   OpenAI: set `OPENAI_API_KEY` and `OPENAI_MODEL`
-   Azure OpenAI: set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT`

In the repo you want to release:

```bash
npx ai-publish prepublish --llm <openai|azure>
# build/package step depends on your ecosystem
npx ai-publish postpublish
```

### Why there must be a pre + post publish

Publishing is the part most likely to fail or require interaction (credentials, OTP/2FA, network, registry errors). ai-publish splits the flow so your git history and tags stay correct:

-   `prepublish` can safely generate outputs and compute `v<next>` without creating a “release commit” or tag.
-   `postpublish` runs the actual publish step first, and only **after publish succeeds** does it create the release commit and annotated `v<next>` tag and push them.

If publishing fails, you do not end up with a pushed release tag that doesn’t correspond to a published artifact.

### Git + tag behavior (what happens when)

`prepublish`:

-   Requires a clean worktree.
-   Refuses if `HEAD` is already tagged with a `v<semver>` tag.
-   Writes release outputs to disk:
    -   changelog (default `CHANGELOG.md`, overridable via `--out`)
    -   release notes at `release-notes/v<next>.md`
    -   optional manifest version update (disabled via `--no-write`)
-   Writes an intent file: `.ai-publish/prepublish.json`.
-   Does **not** create a git commit.
-   Does **not** create a git tag.
-   Does **not** push anything.

`postpublish`:

-   Requires `.ai-publish/prepublish.json` (i.e., you must run `prepublish` first).
-   Runs the project-type publish step first.
-   After publish succeeds, it:
    -   creates a **release commit** containing only the prepared release paths
    -   creates an **annotated tag** `v<next>` pointing at that commit
    -   pushes the current branch and the tag to the remote (default `origin`)
-   Refuses if your working tree has changes outside the release output paths recorded by `prepublish`.

## Recommended release flow

### npm

```bash
npx ai-publish prepublish --llm <openai|azure>
npm run build
npx ai-publish postpublish
```

### .NET

```bash
npx ai-publish prepublish --project-type dotnet --manifest path/to/MyProject.csproj --llm <openai|azure>
dotnet pack -c Release
npx ai-publish postpublish --project-type dotnet --manifest path/to/MyProject.csproj
```

### Rust

```bash
npx ai-publish prepublish --project-type rust --manifest Cargo.toml --llm <openai|azure>
cargo publish --dry-run
npx ai-publish postpublish --project-type rust --manifest Cargo.toml
```

### Python

```bash
npx ai-publish prepublish --project-type python --manifest pyproject.toml --llm <openai|azure>
python -m build
npx ai-publish postpublish --project-type python --manifest pyproject.toml
```

### Go

```bash
npx ai-publish prepublish --project-type go --manifest go.mod --llm <openai|azure>
# build/test as needed
npx ai-publish postpublish --project-type go --manifest go.mod
```

## One-off generation (without publishing)

If you only want to generate markdown (no publish step, no commit/tag/push), you can run the generators directly:

```bash
npx ai-publish changelog --llm openai
npx ai-publish release-notes --llm openai
```

-   `changelog` writes `CHANGELOG.md` by default.
-   `release-notes` writes to `release-notes/v<next>.md` by default when `--out` is omitted and you are not using an explicit `--base` (or `release-notes/<tag>.md` if `HEAD` is already tagged).

## Quickstart (from source)

If you’re developing ai-publish itself:

```bash
npm install
npm run build
```

Then, from the target repo:

```bash
node /path/to/ai-publish/dist/cli.js changelog --llm openai
```

## Core invariants

-   Sole authority for what changed is `git diff <base>..HEAD`.
-   The diff is indexed and queryable.
-   Binary diffs are metadata-only.
-   The full diff is never returned by APIs; callers must request bounded hunks by ID.

These rules are the point of the tool: they make output auditable and make prompt-injection style attacks much harder (because downstream analysis can only “see” bounded evidence).

## How it works (high level)

1. `indexDiff()` runs `git diff <base>..HEAD` with rename detection and builds an index under `.ai-publish/diff-index/<baseSha>..<headSha>/`.
2. Each diff hunk is stored as its own file in `hunks/<hunkId>.patch`.
3. The index manifest (`manifest.json`) contains only metadata + hunk IDs (never full patch content).
4. `getDiffHunks({ hunkIds })` returns only requested hunks, enforcing a total byte limit.

For changes that have no textual hunks (e.g. rename-only), ai-publish creates a metadata-only `@@ meta @@` pseudo-hunk so downstream output can still attach explicit evidence.

This also applies to binary diffs and other hunkless changes: evidence is represented as metadata only.

## Versioning (git tags)

ai-publish treats git tags of the form `v<semver>` as the source of truth for release versions.

-   If `--base` is omitted, the diff base defaults to the most recent reachable `v<semver>` tag commit (otherwise the empty tree).
-   `prepublish` computes a predicted `v<next>` and prepares release outputs locally.
-   `postpublish` creates a local release commit and an annotated tag `v<next>` pointing at that commit after publish succeeds, then pushes the branch + tag.
-   Manifests (e.g. `package.json`, `.csproj`) are updated to match `v<next>` (unless `--no-write`).

## CLI

LLM mode is required for `changelog`, `release-notes`, and `prepublish`: you must pass `--llm openai` or `--llm azure`.
`postpublish` does not use the LLM and does not accept `--llm`.

LLM providers are mentioned below; OpenAI is listed first.

```text
ai-publish changelog [--base <commit>] [--out <path>] --llm <openai|azure> [--commit-context <none|snippet|full>] [--commit-context-bytes <n>] [--commit-context-commits <n>] [--debug]
ai-publish release-notes [--base <commit>] [--out <path>] --llm <openai|azure> [--commit-context <none|snippet|full>] [--commit-context-bytes <n>] [--commit-context-commits <n>] [--debug]
ai-publish prepublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--package <path>] [--no-write] [--out <path>] --llm <openai|azure> [--debug]
ai-publish postpublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--debug]
ai-publish --help
```

### Outputs and defaults

-   `changelog`

    -   Default output path: `CHANGELOG.md`
    -   Writes the changelog markdown, then prints a JSON summary (base resolution, tags, etc.).
    -   If the output file already exists, prepends the newly generated version entry at the top (full history).
        -   Special case: `## [Unreleased]` is replaced (upsert) rather than duplicated.
        -   Legacy `# Changelog (<base>..<head>)` headers are migrated to a `## [<version>]` section when possible.

-   `release-notes`

    -   If `--out` is provided, writes exactly there.
    -   If `--out` is not provided:
        -   If `HEAD` is already tagged `v<semver>`, writes `release-notes/<tag>.md`.
        -   Otherwise (most common, when `--base` is omitted), computes the next version tag and writes `release-notes/v<next>.md`.
        -   If you pass an explicit `--base` and `HEAD` is not tagged, the default output remains `RELEASE_NOTES.md`.
    -   Always prints a JSON summary.

-   `prepublish`

    -   Refuses to run if the git worktree is dirty.
    -   Refuses to run if `HEAD` is already tagged with a version tag.
    -   Writes:
        -   changelog (default `CHANGELOG.md`, overridable via `--out`)
        -   release notes under `release-notes/v<next>.md`
        -   optionally updates the selected manifest version (disabled via `--no-write`)
    -   Does not create a commit or tag (those are created by `postpublish` after publish succeeds).
    -   Prints a JSON result to stdout (it does not print the markdown).
    -   `--package <path>` is a backwards-compatible alias for npm manifests; it implies `--project-type npm`.

    Changelog behavior:

    -   If the changelog output file already exists, prepublish prepends the newly generated version entry at the top (full history).
    -   Legacy `# Changelog (<base>..<head>)` headers are migrated to a `## [<version>]` section when possible.

-   `postpublish`
    -   Requires `.ai-publish/prepublish.json` (i.e., you must run `prepublish` first).
    -   Requires being on a branch (not detached `HEAD`).
    -   Runs a project-type-specific publish step.
    -   After publish succeeds, creates a release commit + annotated `v<next>` tag, then pushes the branch + tag.
    -   Prints a JSON result to stdout.
    -   Note: `--llm` is not accepted for postpublish.

### Logging and tracing (pipelines)

ai-publish prints machine-readable JSON to stdout for several commands. To keep stdout parseable, all logs are written to **stderr**.

Environment variables:

-   `AI_PUBLISH_LOG_LEVEL`: `silent` | `info` | `debug` | `trace` (default: `info` for CLI runs, `silent` for programmatic usage)
-   `AI_PUBLISH_TRACE_TOOLS=1`: logs which bounded semantic tools were called, along with request counts and budget usage (no full diff/snippet dumping)
-   `AI_PUBLISH_TRACE_LLM=1`: logs LLM request/response metadata (provider + label + sizes)
-   `AI_PUBLISH_TRACE_LLM_OUTPUT=1`: prints raw structured LLM outputs (truncated) to stderr

### Recommended release flow

#### npm

1. `ai-publish prepublish --llm <openai|azure>`
2. Build your package.
3. `ai-publish postpublish`

#### .NET

1. `ai-publish prepublish --project-type dotnet --manifest path/to/MyProject.csproj --llm <openai|azure>`
2. Build.
3. `ai-publish postpublish --project-type dotnet --manifest path/to/MyProject.csproj`

### postpublish publish steps by project type

-   `npm`: runs `npm publish`
-   `dotnet`: runs `dotnet pack` then `dotnet nuget push` (requires `--manifest` and `AI_PUBLISH_NUGET_API_KEY` or `NUGET_API_KEY`)
-   `rust`: runs `cargo publish`
-   `go`: no publish command (the “publish” is the pushed tag)
-   `python`: runs `python -m build` then `python -m twine upload dist/*`

## Optional repo instructions (improves accuracy)

ai-publish supports hierarchical instruction files (`AGENTS.md` and Copilot instruction files) to provide context-only configuration.

One practical use: helping ai-publish identify what constitutes public API in repos that don’t follow the default heuristics (monorepos, unusual layouts, non-TypeScript projects).

Add one of these directives to an instruction file:

-   `ai-publish.publicPathPrefixes: src/public, include, api`
-   `ai-publish.publicFilePaths: src/entrypoint.ts`
-   `ai-publish.internalPathPrefixes: generated, vendor`

These directives influence surface classification (`public-api` vs `internal`) and therefore breaking-change heuristics and prioritization, but they do not change the core invariant: only `git diff <base>..HEAD` is evidence of what changed.

## Programmatic usage (TS/JS)

The same functionality is available as a library API with CLI-equivalent parameters.

### Custom LLM clients

For programmatic use, you may optionally provide your own `llmClient` implementation (alternate providers, wrappers/instrumentation, caching, or network-free tests). When `llmClient` is provided, it is used instead of constructing the default client from environment variables.

```ts
import { generateChangelog, generateReleaseNotes } from "ai-publish"

await generateChangelog({
	llm: "openai"
	// llmClient: myCustomClient,
	// base: "<sha>",
	// outPath: "CHANGELOG.md",
	// cwd: process.cwd(),
})

await generateReleaseNotes({
	llm: "openai"
	// llmClient: myCustomClient,
	// base: "<sha>",
	// outPath: "RELEASE_NOTES.md",
	// cwd: process.cwd(),
})
```

## LLM providers

### OpenAI

Set environment variables:

-   `OPENAI_API_KEY`
-   `OPENAI_MODEL` (a chat model that supports JSON-schema structured outputs)
-   `OPENAI_BASE_URL` (optional; default `https://api.openai.com/v1`)
-   `OPENAI_TIMEOUT_MS` (optional)

Note: OpenAI mode uses Structured Outputs (JSON schema). Your selected model must support `response_format: { type: "json_schema", ... }` for Chat Completions.

### Azure OpenAI

Set environment variables:

-   `AZURE_OPENAI_ENDPOINT` (e.g. `https://<resource-name>.openai.azure.com`)
-   `AZURE_OPENAI_API_KEY`
-   `AZURE_OPENAI_DEPLOYMENT` (your chat model deployment name)
-   `AZURE_OPENAI_API_VERSION` (optional; default `2024-08-01-preview`)
-   `AZURE_OPENAI_TIMEOUT_MS` (optional)

Note: LLM mode uses Structured Outputs (JSON schema) and requires Azure OpenAI API versions `2024-08-01-preview` or later.

## Testing

-   `npm test` runs network-free unit + integration tests.
-   End-to-end changelog and release notes generation are covered by integration tests that create temporary git repo fixtures and use a local stub LLM client so outputs are stable without network calls.

### Local semantic acceptance (optional)

Additional integration tests can ask Azure OpenAI to judge whether the generated changelog/release notes accurately reflect the evidence.

-   Opt-in and skipped by default (so CI remains deterministic and network-free).
-   Local-only: skipped when `CI` is set.
-   Run with `npm run test:llm-eval` (requires the Azure env vars listed above).
-   Internally gated by `AI_PUBLISH_LLM_EVAL=1` (the script sets it for you).

The evaluator uses structured JSON output with this schema:

-   `{ "accepted": boolean, "reason": string | null }`

### Local Azure generation (optional)

An additional integration test can ask Azure OpenAI to generate changelog / release notes output end-to-end.

-   Opt-in and skipped by default (so CI remains deterministic and network-free).
-   Local-only: skipped when `CI` is set.
-   Run with `npm run test:llm-generate` (requires the Azure env vars listed above).
-   Internally gated by `AI_PUBLISH_LLM_GENERATE=1` (the script sets it for you).

### When to run LLM tests

If you change any of the following, run both `npm run test:llm-eval` and `npm run test:llm-generate` in addition to `npm test`:

-   `src/llm/*` (Azure/OpenAI clients)
-   LLM pipeline orchestration in `src/pipeline/*`
-   Output schemas/contracts used by the LLM passes

## Troubleshooting

-   `Missing required flag: --llm`

    -   `changelog`, `release-notes`, and `prepublish` require `--llm openai` or `--llm azure`.

-   `HEAD is already tagged ... Refusing to prepublish twice.`

    -   `prepublish` is intentionally one-shot per version. Move `HEAD` forward or delete the tag if you’re intentionally retrying.

-   `No user-facing changes detected (bumpType=none). Refusing to prepare a release.`

    -   ai-publish refuses to cut a release if the changelog model has no user-facing changes.

-   `Missing .ai-publish/prepublish.json. Run prepublish first.`

    -   `postpublish` requires the intent file written by `prepublish`.

-   `.NET postpublish requires --manifest <path/to.csproj>`

    -   Provide `--manifest` for `dotnet` project type.

-   `Missing NuGet API key...`
    -   Set `AI_PUBLISH_NUGET_API_KEY` (or `NUGET_API_KEY`) before running `dotnet postpublish`.
