# Euclid — working conventions

Read README.md for architecture. Non-negotiables when changing code:

- **Purity invariant**: `packages/engine` must stay a pure function of
  (document, time). Never use Date.now(), Math.random(), or accumulated
  state in the sampler or stage. Preview and export must stay pixel-identical.
- **All mutations are ops.** Never mutate a document directly — add an op to
  `packages/dsl/src/ops.ts` and handle it in the shared reducer. The DO, the
  editor, and MCP tools must all go through `applyOps`.
- **Schema changes**: `packages/dsl` is the contract for every app. Bump
  SCHEMA_VERSION on breaking document changes; keep Zod schemas and TS
  interfaces in sync (interfaces are explicit, not inferred, because of
  recursion in NodeSchema).
- **Workers must not import Pixi.** Pixi lives behind `@euclid/engine/pixi`;
  Workers import only `@euclid/engine` (the pure sampler).
- **MCP tools return cheap text** (outlines, ids, errors) so agent iteration
  stays free; only render/TTS spend credits.
- Packages export TS source directly (`main: src/index.ts`); consumers bundle.
  `pnpm -r typecheck` must pass before considering work done.
- Verify visual changes with
  `pnpm --filter @euclid/renderer exec tsx src/shot.ts <t...>` (vite dev
  server must be running) and read the PNGs.
- **Docs discipline**: reference docs live in `docs/`, phased plans in
  `docs/plans/` with `- [ ]`/`- [x]` task markers. When you complete plan
  work, flip the markers in the same commit. New significant work starts a
  new `NNN-name.md` plan. Env changes go in root `.env` (safe defaults) or
  `.env.local` (secrets — never committed); `.dev.vars` files are generated,
  never hand-edited.
