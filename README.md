# ai-publish

AI-assisted release authoring: generates a changelog, release notes, and the next version number.

ai-publish is built to do that _without_ letting the model invent changes: the only authority for “what changed” is `git diff <base>..HEAD`, and downstream analysis is constrained to bounded diff hunks.

## Quickstart

Install as a dev dependency (recommended):

```bash
npm install --save-dev ai-publish
```

In the repo you want to generate outputs for:

```bash
npx ai-publish changelog --llm azure
npx ai-publish release-notes --llm azure
```

- `changelog` writes `CHANGELOG.md` by default.
- `release-notes` writes to `release-notes/v<next>.md` by default (or `release-notes/<tag>.md` if `HEAD` is already tagged).

## Quickstart (from source)

If you’re developing ai-publish itself:

```bash
npm install
npm run build
```

Then, from the target repo:

```bash
node /path/to/ai-publish/dist/cli.js changelog --llm azure
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
-   `prepublish` creates a local release commit and an annotated tag `v<next>` pointing at that commit.
-   Manifests (e.g. `package.json`, `.csproj`) are updated to match `v<next>` (unless `--no-write`).

## CLI

LLM mode is required for all commands: you must pass `--llm azure` or `--llm openai`.

```text
ai-publish changelog [--base <commit>] [--out <path>] --llm <azure|openai>
ai-publish release-notes [--base <commit>] [--out <path>] --llm <azure|openai>
ai-publish prepublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] [--package <path>] [--no-write] [--out <path>] --llm <azure|openai>
ai-publish postpublish [--project-type <npm|dotnet|rust|python|go>] [--manifest <path>] --llm <azure|openai>
ai-publish --help
```

### Outputs and defaults

-   `changelog`

    -   Default output path: `CHANGELOG.md`
    -   Writes the changelog markdown, then prints a JSON summary (base resolution, tags, etc.).

-   `release-notes`

    -   If `--out` is provided, writes exactly there.
    -   If `--out` is not provided:
        -   If `HEAD` is already tagged `v<semver>`, writes `release-notes/<tag>.md`.
        -   Otherwise (most common), computes the next version tag and writes `release-notes/v<next>.md`.
    -   Always prints a JSON summary.

-   `prepublish`

    -   Refuses to run if the git worktree is dirty.
    -   Refuses to run if `HEAD` is already tagged with a version tag.
    -   Writes:
        -   changelog (default `CHANGELOG.md`, overridable via `--out`)
        -   release notes under `release-notes/v<next>.md`
        -   optionally updates the selected manifest version (disabled via `--no-write`)
    -   Creates a local release commit and an annotated tag `v<next>`.
    -   Prints a JSON result to stdout (it does not print the markdown).
    -   `--package <path>` is a backwards-compatible alias for npm manifests; it implies `--project-type npm`.

-   `postpublish`
    -   Refuses to run if the git worktree is dirty.
    -   Requires `HEAD` to be tagged with `v<semver>` and requires that tag to point at `HEAD`.
    -   Runs a project-type-specific publish step, then pushes the current branch + version tag.
    -   Prints a JSON result to stdout.
    -   Note: `--llm` is still required for CLI parity, but postpublish does not use the LLM.

### Recommended release flow

#### npm

1. `ai-publish prepublish --llm <azure|openai>`
2. Build your package.
3. `ai-publish postpublish --llm <azure|openai>`

#### .NET

1. `ai-publish prepublish --project-type dotnet --manifest path/to/MyProject.csproj --llm <azure|openai>`
2. Build.
3. `ai-publish postpublish --project-type dotnet --manifest path/to/MyProject.csproj --llm <azure|openai>`

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
	llm: "azure"
	// llmClient: myCustomClient,
	// base: "<sha>",
	// outPath: "CHANGELOG.md",
	// cwd: process.cwd(),
})

await generateReleaseNotes({
	llm: "azure"
	// llmClient: myCustomClient,
	// base: "<sha>",
	// outPath: "RELEASE_NOTES.md",
	// cwd: process.cwd(),
})
```

## LLM providers

### Azure OpenAI

Set environment variables:

-   `AZURE_OPENAI_ENDPOINT` (e.g. `https://<resource-name>.openai.azure.com`)
-   `AZURE_OPENAI_API_KEY`
-   `AZURE_OPENAI_DEPLOYMENT` (your chat model deployment name)
-   `AZURE_OPENAI_API_VERSION` (optional; default `2024-08-01-preview`)
-   `AZURE_OPENAI_TIMEOUT_MS` (optional)

Note: LLM mode uses Structured Outputs (JSON schema) and requires Azure OpenAI API versions `2024-08-01-preview` or later.

### OpenAI

Set environment variables:

-   `OPENAI_API_KEY`
-   `OPENAI_MODEL` (a chat model that supports JSON-schema structured outputs)
-   `OPENAI_BASE_URL` (optional; default `https://api.openai.com/v1`)
-   `OPENAI_TIMEOUT_MS` (optional)

Note: OpenAI mode uses Structured Outputs (JSON schema). Your selected model must support `response_format: { type: "json_schema", ... }` for Chat Completions.

## Testing

-   `npm test` runs network-free unit + integration tests.
-   End-to-end changelog generation is covered by integration tests that create temporary git repo fixtures and use a local stub LLM client so outputs are stable without network calls.

### Local semantic acceptance (optional)

An additional integration test can ask Azure OpenAI to judge whether the generated changelog accurately reflects the evidence.

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

    -   All commands require `--llm azure` or `--llm openai`.

-   `HEAD is already tagged ... Refusing to prepublish twice.`

    -   `prepublish` is intentionally one-shot per version. Move `HEAD` forward or delete the tag if you’re intentionally retrying.

-   `No user-facing changes detected (bumpType=none). Refusing to create a release commit/tag.`

    -   ai-publish refuses to cut a release if the changelog model has no user-facing changes.

-   `HEAD is not tagged with a version tag. Run prepublish first.`

    -   `postpublish` requires a version tag `v<semver>` on `HEAD`.

-   `.NET postpublish requires --manifest <path/to.csproj>`

    -   Provide `--manifest` for `dotnet` project type.

-   `Missing NuGet API key...`
    -   Set `AI_PUBLISH_NUGET_API_KEY` (or `NUGET_API_KEY`) before running `dotnet postpublish`.
