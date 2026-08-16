# 004 — Desktop app (status: evaluated, not started)

Question asked 2026-08-14: is there a benefit to shipping a desktop app?
Answer: yes, and an unusually strong one for this product — but the right
time is **after** the general-video direction settles, not now.

This doc records the case and the reasoning so the decision doesn't have to
be re-derived.

## The case, in one line

**Everything that breaks on the server is abundant on the desktop.**

[plans/003](003-general-video.md) measured a stock Linux container: no H.264
encoder, no GPU, WebGL falling back to SwiftShader — forcing a
VP9-then-transcode pipeline. On a user's machine all three problems
disappear: hardware H.264 via VideoToolbox/Media Foundation, a real GPU for
Pixi, no software rasterization. The server workaround becomes unnecessary
rather than merely tolerable.

## Four real benefits

1. **Render economics invert.** Every render currently costs us container
   CPU. [market.md](../market.md) found this is exactly where Revideo's
   business failed — hosted rendering is thin-margin commodity compute that
   customers can self-host anyway. On desktop, rendering uses hardware the
   user already bought, and it runs *faster* than our server does. Cloudflare
   Containers, the render queue, and R2 output storage become optional.
2. **Local media — decisive for reels.** Source footage lives on disk, often
   in gigabytes. Requiring an upload before editing is poor UX and expensive
   bandwidth plus storage for us. Premiere, DaVinci and CapCut are
   desktop-first for this reason; a general video editor that must ingest
   everything to the cloud first is fighting its own category. Also a privacy
   selling point: client and unreleased footage never leaves the machine.
3. **The agent path loses its infrastructure.** Compare the friction already
   hit in dev — quick tunnels with rotating URLs, OAuth for claude.ai,
   service-binding discovery breaking on restart. A desktop app with a local
   MCP server has none of it: Claude Code runs on the same machine and
   connects over localhost with no auth at all.
4. **Precedent in our own niche.** Animo ships a desktop app at **$49
   one-time**, using the user's existing Claude/ChatGPT subscription — the
   same bring-your-own-agent economics we designed for.

## What it costs

- **Distribution friction**: code signing (~$99/yr Apple plus a Windows
  certificate), notarization, auto-update infrastructure, platform-specific
  bugs, and an install step before anyone can try the product. Web's
  zero-friction trial genuinely matters for conversion.
- **The business model problem — what is left to charge for?** With local
  rendering *and* a bring-your-own agent, the credit system loses its
  subject. Remaining candidates: TTS, publishing/sharing, collaboration,
  team seats, or a one-time license (Animo's answer, which caps revenue).
  This needs deciding before, not after, building.
- **Not the code, though.** Electron or Tauri wraps the *same* React app;
  `packages/engine` and `apps/web` run unchanged because the renderer is
  already a browser page. This is a shell, not a rewrite.

## Recommendation: hybrid, staged

Desktop owns the editor, local media, and rendering. Cloud owns accounts,
document sync, sharing, publishing, and TTS. **Render locally by default**
(free, fast, GPU) and sell cloud rendering as a convenience for long jobs or
weak machines.

This resolves the tension in [market.md](../market.md) directly:
price-sensitive individual creators get a product that costs us nothing per
render, while teams pay for cloud and collaboration.

The architecture already supports it. The document is small JSON that syncs
trivially; the ops/event-log design handles reconciliation; and the purity
invariant means a local render and a cloud render produce identical output —
so "render here or there" is a deployment choice, not a correctness one.

## If we build it: Electron, not Tauri

Despite Tauri's much smaller bundles. Tauri uses the **system webview**, so
WebCodecs support varies by platform — Chromium-based WebView2 on Windows is
fine, but WebKit on macOS and especially WebKitGTK on Linux are weaker and
inconsistent. Electron bundles Chromium, giving us the exact engine the
renderer is already tested against. For a video app, codec consistency
outweighs bundle size.

## Timing — do not start yet

The strongest argument (local media) is a general-video concern. Starting a shell
mid-Phase-2 would be premature, and the WebCodecs work in
[plans/003](003-general-video.md) is required under either future.

**Trigger conditions for revisiting:**
- The general-video/reels direction is confirmed and `video` nodes exist, or
- Container render cost or throughput becomes a real constraint (see the
  unmeasured SwiftShader risk in plans/003), or
- User conversations show creators unwilling to upload source footage.

## Open questions

- What does the free tier look like if rendering is free for us? (Probably
  watermark or resolution cap, same as today — but the *reason* changes from
  cost recovery to upsell.)
- Does TTS stay server-side (our key, metered) or become bring-your-own-key
  like the agent? BYO-key is consistent with the desktop model and removes
  the last per-use cost, but removes the last per-use revenue too.
- Does the editor stay web-first with desktop as a wrapper, or does desktop
  get capabilities web can't have (filesystem watching, native file dialogs,
  hardware encode selection)? Divergence is where the maintenance cost hides.
