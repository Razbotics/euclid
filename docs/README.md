# Euclid docs

These docs are maintained **with** the code, not after it: every change that
affects behavior updates the relevant doc and plan markers in the same commit.
See the mapping table in [CLAUDE.md](../CLAUDE.md) for which doc to touch.

Two kinds of content live here:

- **`docs/*.md`** — developer reference: how things work and why. Written for
  someone joining the project (human or agent). Keep these current when the
  behavior they describe changes.
- **`docs/plans/*.md`** — numbered, phased execution plans. Each plan is a
  sequence of phases; each phase has a task list with completion markers:

  ```
  ## Phase 2: TTS pipeline   (status: in progress)
  - [x] TTS adapter interface
  - [ ] OpenAI provider with word timestamps
  ```

  Mark tasks `[x]` as they land (same commit as the work when possible).
  A plan whose phases are all complete gets `(status: done)` in its title and
  stays in place as history. New significant work starts with a new plan file:
  `NNN-short-name.md`, next number in sequence.

## Index

| Doc | What's in it |
|---|---|
| [architecture.md](architecture.md) | System shape: document model, sync, render path, credits |
| [dev-setup.md](dev-setup.md) | Local environment, commands, verification tools |
| [mcp-tools.md](mcp-tools.md) | The agent-facing tool surface and its semantics |
| [market.md](market.md) | Competitive landscape, monetization evidence, strategy |

| Plan | Scope |
|---|---|
| [plans/000-roadmap.md](plans/000-roadmap.md) | Top-level phases from scaffold to launch |
| [plans/001-local-e2e.md](plans/001-local-e2e.md) | Local backend + agentic loop verification |
| [plans/002-render-pipeline.md](plans/002-render-pipeline.md) | Export, job loop, TTS, audio — toward the v1 milestone |
| [plans/003-general-video.md](plans/003-general-video.md) | Direction change: assets, video/audio nodes, reels, ingest |
| [plans/004-desktop.md](plans/004-desktop.md) | Desktop app: the case, costs, and why not yet |
