# MCP tool surface

The agent-facing API (`apps/mcp/src/index.ts`). Design rules:

- Tools speak **intent** (`animate`, `morph_latex`); everything compiles to
  DSL ops submitted through the API worker to the project's Durable Object.
- Tool results are **compact text** — outlines, ids, time ranges — so agent
  iteration stays cheap/free. Only `render_video` (and TTS at render time)
  costs credits.
- Writes auto-rebase: fetch version → submit → retry ×3 on 409.
- Coordinates are canvas pixels, origin top-left. Times are scene-local
  seconds. Nodes anchor at their center.

| Tool | Semantics |
|---|---|
| `list_projects` / `create_project` | dashboard-level CRUD |
| `get_project` | cheap text outline of everything — call freely |
| `get_scene` | full JSON of one scene for detailed inspection |
| `add_scene` | appends a scene (name, duration, background) |
| `add_latex` / `add_text` / `add_shape` | create nodes with sensible defaults, return the node id |
| `update_node` | shallow patch; `id`/`type` immutable; invalid patches rejected atomically |
| `remove_node` | delete |
| `animate` | keyframes one property from its **current value sampled at `start`** to `to` over `duration` — animations always chain continuously; replaces that property's keyframes after `start` |
| `morph_latex` | queues a `texMorph` transition; multiple morphs chain in start-time order |
| `write_on` | draw-on reveal; node invisible before `start` |
| `set_narration` | per-scene narration script; TTS generated at render time |
| `render_video` | **spends credits** up front; returns a job id. The render worker completes the job asynchronously |
| `get_render_status` | recent jobs; a `done` job carries `downloadUrl` for the MP4, and a `failed` job has already had its credits refunded |

Auth: currently `dev-user` via the internal service key. TODO: OAuth
(workers-oauth-provider backed by the API's Better Auth) so claude.ai
connects as a real user — tracked in plans/000-roadmap.md.
