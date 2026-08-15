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
- Tools report what they *did*, not what they were asked to do. Several
  succeed in ways that change nothing on screen — a patch shadowed by a
  track, narration cut at a scene edge — and say so in the result rather
  than leaving it to be discovered in a render.

| Tool | Semantics |
|---|---|
| `list_projects` / `create_project` | dashboard-level CRUD |
| `get_project` | cheap text outline of everything — call freely. Includes pacing: total silence as a percentage, and per scene `speech=`/`tail=`, with tails over 2s marked `(long)` |
| `get_scene` | full JSON of one scene for detailed inspection |
| `add_scene` | appends a scene (name, duration, background) |
| `update_scene` | patch a scene's name/duration/background; extending `duration` is the fix when narration overruns |
| `add_latex` / `add_text` / `add_shape` | create nodes with sensible defaults, return the node id |
| `update_node` | shallow patch; `id`/`type` immutable. Invalid patches are rejected atomically, **and so is a key the node has no property for** — it errors naming the key instead of silently changing nothing. Position is `{"position":{"x":…,"y":…}}`, not the top-level `x`/`y` that `add_text`/`add_latex` accept. Patching a property an animation keyframes **changes the document but not the render** — the track wins — so the result says so; use `animate` for those, or clear the track first |
| `remove_node` | delete |
| `animate` | keyframes one property from its **current value sampled at `start`** to `to` over `duration` — animations always chain continuously; replaces that property's keyframes after `start` |
| `morph_latex` | queues a `texMorph` transition; multiple morphs chain in start-time order, and a call whose window **overlaps** an existing morph replaces it (as `highlight` does), so re-calling revises rather than stacks. Clean for *additive* changes — appending terms holds the existing glyphs still; a change that re-lays-out the equation, such as collapsing into a fraction, is briefly illegible mid-morph, so prefer several small morphs over one structural leap |
| `write_on` | draw-on reveal; node invisible before `start` |
| `highlight` | emphasise a node, or one term inside an equation named by its LaTeX (`tex: "\\frac{b}{a}"`) — located by glyph codes, so no coordinates are needed. Styles: `color` recolours the term (default), `spotlight` dims everything else, `box`/`underline` draw a marker. Sequential highlights on one node accumulate; a call overlapping an existing window replaces it. Free |
| `set_narration` | per-scene narration script. Free — writes text only |
| `generate_narration` | **spends credits** (priced by script length). Synthesizes the scene's narration, stores the audio, and writes word timings into the document as a `system` op. Reports — but does not reject — speech that overruns the scene |
| `fit_scene_to_narration` | set a scene's duration to its speech plus a held tail — the one-call fix for the dead air `get_project` flags as `(long)` |
| `ask_user` | put a choice to the human **in chat** and stop. Free, and blocking by intention. If the client supports MCP elicitation the human answers in its own picker and the result comes straight back; otherwise it returns a ready-to-paste block with numbered options for you to relay. The question is also stored on the project (queryable, audit-trailed) but **no UI mirrors it** — chat is the surface, and the system may be headless, so never wait on a browser |
| `get_answer` | poll for the human's answer, or list every question and its status. Free. While anything is open it repeats that you are **still blocked** — polling and then carrying on is the same failure as never asking |
| `record_answer` | record an answer the human gave you in conversation. Provenance is kept and ranked by trust: `chat` (elicited — nothing interpreted it), `editor` (clicked), `agent` (this tool — your reading of what they said, the only path where the answer is an interpretation). First answer wins; a second is refused rather than overwriting |
| `list_assets` | the project's files as a tree — narration audio today, footage later. Free. Paths are virtual (folders derived), and each file is marked in-use or unused so a leftover from a regenerated scene is visible |
| `move_asset` | rename or move a file by writing a new virtual path; folders are implicit, so there is nothing to mkdir and no empty folder to clean up |
| `remove_asset` | delete a file. **Refuses** if the document still references it, naming the scenes — a scene must never point at nothing; `force: true` overrides deliberately |
| `get_captions` | SRT/VTT subtitles for the project. Free — derived from narration; word-accurate where TTS timings exist, estimated elsewhere |
| `render_video` | **spends credits** up front (video seconds only; narration is billed by `generate_narration`); returns a job id. The render worker completes the job asynchronously |
| `get_render_status` | recent jobs; a `done` job carries `downloadUrl` for the MP4, and a `failed` job has already had its credits refunded |

Auth: currently `dev-user` via the internal service key. OAuth
(workers-oauth-provider backed by the API's Better Auth), so claude.ai
connects as a real user, is Phase 5 in [plans/000](plans/000-roadmap.md) —
deliberately last. Note what that client implies for this surface: it has no
shell, so every tool result here is its only feedback. That is the argument
[plans/007](plans/007-agent-sight.md) is built on.
