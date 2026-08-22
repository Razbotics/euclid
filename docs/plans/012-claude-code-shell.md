# 012 — The Claude Code shell (status: done)

Rebuild the editor chrome in the shape of Claude Code's desktop app: a thin
sidebar rail for switching contexts, the canvas and timeline owning the
centre, and workspace detail as optional right-hand panels that stack as
they open. The document surfaces themselves (canvas, timeline, inspector,
review queue, explorer, file viewers) are unchanged — this plan moves the
walls, not the furniture.

## Why

The old shell was VS Code's: explorer | editor | scene, both sides open by
default. That spends two permanent columns on content that is consulted
occasionally (files, properties) while the thing being made — the video —
shares what is left. Claude Code's arrangement matches how this editor is
actually used: the human watches the canvas while an agent works, and
reaches for files or the inspector on demand.

## Phase 1: shell (status: done)

- [x] `Sidebar.tsx` — 46px rail, hover-expanding flyout **overlay** (never a
      column: opening it must not reflow the canvas) listing every project
      newest first; account button at the bottom of rail and flyout opening
      the future settings menu (placeholder entries, deliberately present
      before settings exist so the spot is discoverable)
- [x] Kill the project-list page: bare `/` auto-opens the newest project via
      `location.replace` (Back does not bounce); no projects → landing note;
      the flyout is the list now
- [x] Right side: closed by default; ⋯ header menu toggles Files / Scene /
      Review panels, stacking vertically in open order, each with its own
      header and ✕; ⌘B / ⌘⌥B toggle Files / Scene; open set + stack width
      in `localStorage` (`euclid.panels.v2`)
- [x] Review panel opens itself on a *new* agent question (keyed on the
      open-decision count so dismissing sticks until the next question);
      with everything closed, a waiting question is a dot on the ⋯ button
- [x] Timeline moves into the centre column — it is the document's
      transport, and the panels beside it are not part of that transport
- [x] Claude-style warm dark palette as CSS variables in `styles.css`
      (`--bg`/`--accent`/…), one token block instead of scattered hex
- [x] `check-app.ts` rewritten for the new contract; passes against a live
      API (61 projects) — stack closed on a fresh profile, menu stacks
      panels in order, flyout lists/opens projects, `/` lands on the newest

## Notes / gotchas

- The ⋯ menu is modal — its backdrop swallows the page, including the
  sidebar hover. Anything driving the UI (checks, agents) must close the
  menu before touching what is under it.
- The demo item lives in the flyout too, so the offline path stays reachable
  without typing `?demo=1`.
- Panel state key moved `euclid.panels` → `euclid.panels.v2`: the old shape
  (left/right booleans + two widths) does not describe a stack, and reading
  it as one would resurrect half a layout.
