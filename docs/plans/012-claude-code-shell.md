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

## Phase 2: feedback round (status: done)

What the first build got wrong, per review of the running shell:

- [x] Sidebar modes instead of hover-always: **docked** column by default
      (no hover behaviour at all), and the top-left toggle switches to
      **hover** mode — the column disappears, only the button remains in the
      header, and hovering *the button* reveals the overlay. Mode remembered
      (`euclid.sidebar`). The 46px rail is gone.
- [x] ⋯ menu entries carry glyphs (folder / layers / check), ✓ on the right
      when open; the same glyphs title the stack panels
- [x] No tab strip: the centre is canvas + timeline only. A selected file
      opens as *its own card directly under Files*, one at a time, toggled
      off by reselecting or ✕; deletion closes it. FileViewer gained an
      optional `onClose`, and lost its open-in-tab link (the card's save
      link remains).
- [x] Stack partitions as cards, Claude Code style: rounded, bordered, gap
      between panels, per-panel expand (maximize one, fold the rest to their
      headers — session-only, like solo) and close controls, all drawn as
      SVG icons in fixed 24px hit boxes rather than text glyphs
- [x] Sidebar partition lines: under the header, above the account row
- [x] Timeline gutter: bordered seam against the scroller, uppercase lane
      labels, tightened transport buttons
- [x] `color-scheme: dark` at `:root`, so native audio/video controls and
      scrollbars stop rendering as white furniture

## Phase 3: library, seams (status: done)

- [x] Library rows open in the viewer card like project files — the row is
      dressed as a `ProjectFile` (`usedBy: false`) and the id lookup spans
      both lists; a library row aligns with folder children (same 10px
      indent) so the two lists read as one tree
- [x] The per-row ↗ open-in-tab action is gone from the tree (the viewer
      card is the way to look at a file; Review keeps its `open ↗` fallback
      for kinds the card cannot render inline)
- [x] Vertical resizing between cards: the 9px gap between two cards is the
      drag handle, trading height between exactly that pair as flex weights
      whose sum the drag preserves (90px floor per card); weights persist
      with the rest of the panel state

## Notes / gotchas

- The ⋯ menu is modal — its backdrop swallows the page, including the
  sidebar hover. Anything driving the UI (checks, agents) must close the
  menu before touching what is under it.
- The demo item lives in the flyout too, so the offline path stays reachable
  without typing `?demo=1`.
- Panel state key moved `euclid.panels` → `euclid.panels.v2`: the old shape
  (left/right booleans + two widths) does not describe a stack, and reading
  it as one would resurrect half a layout.
