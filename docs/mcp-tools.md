# MCP tool surface

The agent-facing API (`apps/mcp/src/index.ts`). Design rules:

- Tools speak **intent** (`animate`, `morph_latex`); everything compiles to
  DSL ops submitted through the API worker to the project's Durable Object.
- Tool results are **compact text** — outlines, ids, time ranges — so agent
  iteration stays cheap/free. Only `render_video` and `generate_narration`
  cost credits; every other tool is free to call as often as needed.
- Writes auto-rebase: fetch version → submit → retry ×3 on 409.
- Coordinates are canvas pixels, origin top-left. Times are scene-local
  seconds. Nodes anchor at their center.

| Tool | Semantics |
|---|---|
| `list_projects` / `create_project` | dashboard-level CRUD |
| `get_project` | cheap text outline of everything — call freely. Includes pacing: total silence as a percentage, and per scene `speech=`/`tail=`, with tails over 2s marked `(long)` |
| `get_scene` | full JSON of one scene for detailed inspection |
| `add_scene` | appends a scene (name, duration, background) |
| `update_scene` | patch a scene's name/duration/background; extending `duration` is the fix when narration overruns |
| `add_latex` / `add_text` / `add_shape` | create nodes with sensible defaults, return the node id |
| `update_node` | shallow patch; `id`/`type` immutable; invalid patches rejected atomically |
| `remove_node` | delete |
| `animate` | keyframes one property from its **current value sampled at `start`** to `to` over `duration` — animations always chain continuously; replaces that property's keyframes after `start` |
| `morph_latex` | queues a `texMorph` transition; multiple morphs chain in start-time order |
| `write_on` | draw-on reveal; node invisible before `start` |
| `highlight` | box or underline a node, or one term inside an equation named by its LaTeX (`tex: "\\frac{b}{a}"`) — located by glyph codes, so no coordinates are needed. Free |
| `set_narration` | per-scene narration script. Free — writes text only |
| `generate_narration` | **spends credits** (priced by script length). Synthesizes the scene's narration, stores the audio, and writes word timings into the document as a `system` op. Reports — but does not reject — speech that overruns the scene |
| `fit_scene_to_narration` | set a scene's duration to its speech plus a held tail — the one-call fix for the dead air `get_project` flags as `(long)` |
| `ask_user` | put a choice to the human instead of deciding alone. Free. Appears live in their editor, where they can scrub to the moment in question before answering. Returns a decision id |
| `get_answer` | poll for the human's answer, or list every question and its status. Free |
| `record_answer` | record an answer the human gave in chat rather than in the editor; provenance is kept (`via: agent` vs `via: editor`) |
| `get_captions` | SRT/VTT subtitles for the project. Free — derived from narration; word-accurate where TTS timings exist, estimated elsewhere |
| `render_video` | **spends credits** up front (video seconds only; narration is billed by `generate_narration`); returns a job id. The render worker completes the job asynchronously |
| `get_render_status` | recent jobs; a `done` job carries `downloadUrl` for the MP4, and a `failed` job has already had its credits refunded |

Auth: currently `dev-user` via the internal service key. TODO: OAuth
(workers-oauth-provider backed by the API's Better Auth) so claude.ai
connects as a real user — tracked in plans/000-roadmap.md.
