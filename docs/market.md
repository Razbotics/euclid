# Market analysis — Euclid

Researched 2026-08-14. Strategic context for the open-source + hosted
question. Revisit when the competitive picture moves; this is a snapshot,
not a standing truth.

> **Superseded in part (2026-08-14).** The product direction changed: Euclid
> is no longer scoped to educational math animation (see
> [plans/003-general-video.md](plans/003-general-video.md)). That resolves
> the differentiation-vs-monetization tension identified below — general
> video has budget — at the cost of entering two crowded categories:
> agentic motion graphics (Midrender, Motion) and clip generation from
> source video (Opus Clip, Reap). The competitive facts below still hold;
> the strategic conclusion about staying niche does not.

## Bottom line

The architecture Euclid is built on — MCP agent + visual timeline editor +
deterministic document — is **already shipping from a YC-backed competitor**
(Midrender, formerly Revideo). Euclid's defensible wedge is not the
architecture; it is the **math/explanatory niche** (LaTeX morphing,
3b1b-style animation) that nobody in the agentic-video space is serving well.

The tension to resolve: that niche has the *lowest willingness to pay* in
the market. Differentiation and monetization point in opposite directions.

## The competitive map

Three distinct clusters, only one of which is a real threat.

### 1. Programmatic video libraries (the infrastructure layer)

| Player | Model | Relevance |
|---|---|---|
| [Remotion](https://www.remotion.dev/docs/license/pricing) | Source-available. Free for individuals/non-profits/for-profit teams ≤3; **$25/seat/mo** company license above that; $100/mo minimum for render-based licensing | The proof that source-available + seat licensing *works* in this exact space |
| [Revideo](https://github.com/midrender/revideo) | MIT, monetize via hosted cloud rendering | **Tried the user's proposed model and moved off it** — see below |
| [Motion Canvas](https://motioncanvas.io) | MIT, no commercial arm | Community project, not a competitor |
| [Manim](https://www.manim.community/) | Community-maintained Python, MIT | The incumbent for math animation; Python-native, code-only, no editor |

### 2. Agentic motion graphics (the direct threat)

**[Midrender](https://midrender.com/)** — built on Revideo's engine, [YC-backed](https://www.ycombinator.com/companies/revideo). Their own description is close to verbatim Euclid: AI agents and humans collaborate on motion graphics, everything stays manually editable, a real visual editor with timeline/properties/keyframes, and it *speaks MCP so you can connect Claude Code or Cursor*.

They are ahead on engine maturity (Motion Canvas lineage, years of work) and have paying customers. **But they target general motion graphics — explicitly not educational or mathematical animation.**

Also in this cluster: [Motion](https://motion.so/) ("frontier agent for motion design", launches/demos/ads), and a growing set of [MCP video-editing servers](https://www.wireflow.ai/blog/best-mcp-server-for-video-editing-tools-in-2026) like [Reap](https://reap.video/mcp) — though those do clip/caption/dub on existing footage, not generative animation.

### 3. AI-Manim wrappers (the niche incumbents)

Tools that turn a prompt into Manim code and render it:
[Animo](https://animo.video/about) (desktop app, **$49 one-time**, bring your own Claude/ChatGPT key),
[AnimG](https://animg.app/en) (browser, freemium),
[Generative Manim](https://github.com/marcelo-earth/generative-manim) (free/OSS).

These are the closest thing to Euclid's *use case*, and they're weak
products — code-generation roulette with no live editor, no manual editing,
no determinism. Euclid's document model is categorically better. **But look
at the price points.**

## The uncomfortable arithmetic

- Remotion charges **$25/seat/month** to companies making marketing and
  product video.
- Animo charges **$49 once**, forever, to individuals making math animation.

That gap is the market telling you something. Motion graphics for
marketing/product is a business expense with budget behind it. Math
animation is bought by teachers, YouTube educators, and course creators —
price-sensitive individuals, many of whom will use a free tool instead.

The broader AI-video market is growing fast (~$847M in 2026 → ~$3.35B by
2034, [~18.8% CAGR](https://garagefarm.net/blog/how-ai-animation-tools-are-transforming-content-creation)),
but nearly all of that value sits in marketing/avatar/product video, not
explanatory math.

## Evidence on the open-source + hosted model

This is the most decision-relevant finding, because two companies in this
exact niche ran the experiment:

**Remotion — source-available + seat licensing: working.** Not OSI open
source. Free for individuals and small teams, paid above 4 people, no
feature difference between free and paid. Monetizes the *developers*, not
the compute.

**Revideo — MIT + hosted rendering: abandoned.** MIT-licensed, business
model was hosted cloud rendering at re.video. They [pivoted](https://midrender.com/revideo)
to building Midrender, a visual editor with AI and MCP, and now "primarily
work on Midrender." The rendering-as-a-service layer did not become the
business; the *interface* did.

The lesson is unkind to pure "open source + hosted rendering": rendering is
a commodity that customers can self-host (that's the point of MIT), and the
margin on ffmpeg-in-a-container is thin. The durable value was the editor
and the agent integration.

## What is actually defensible for Euclid

Ranked by how hard each is to copy:

1. **The math/explanatory niche.** LaTeX morphing done well (matched-glyph,
   not crossfade), graphs/axes, proof choreography. Midrender won't build
   this — it's a different customer. Manim has it but is Python-only,
   code-only, no live editor, no agent.
2. **The deterministic document + reducer.** Pure `(document, time)`
   rendering, ops+event-log sync, one mutation path for agent and human.
   This is genuinely good architecture and it's why manual and agentic edits
   compose instead of fighting. Copyable, but not cheaply.
3. **Bring-your-own-agent economics.** Users spend their own Claude tokens;
   you meter only renders and TTS. Structurally cheaper to operate than
   competitors who eat inference cost. Also a weakness: the agent isn't
   yours, so agent quality isn't your moat.

Not defensible: headless Chromium + ffmpeg rendering, MCP tool surfaces,
credit systems, timeline UIs.

## Recommended model

Follow Remotion's shape, not Revideo's:

- **Open source the engine** (`packages/dsl` + `packages/engine`) under a
  permissive license. This is the Manim-for-TypeScript play: it earns
  adoption, contributions, and credibility, and it's the piece people want
  to self-host anyway. It also makes the document format a standard rather
  than a lock-in, which is what gets an agentic tool adopted.
- **Keep the product closed**: the collaborative editor, project/document
  service, MCP hosting, auth, credits, dashboard. This is what Revideo
  learned the hard way — the interface is the business.
- **Do not build the business on hosted rendering margin.** Credits should
  cover cost and friction, not be the revenue engine.
- **Charge seats for professional use** once there's a team story
  (studios, edtech companies, course platforms), because that's where the
  budget is. Individual educators get a generous free tier — they're your
  distribution, not your revenue.

Rough shape: free for individuals (watermark or resolution cap), ~$20-30/mo
for creators who publish regularly, seat-based team pricing for edtech and
studios, credits for render/TTS overage.

## Key risks

1. **Midrender adds math primitives.** Their engine could grow LaTeX support
   in a sprint. Mitigation: go deep enough on explanatory animation
   (matched-glyph morphs, graph choreography, narration-anchored timing)
   that shallow support doesn't compete.
2. **Niche can't pay.** The likeliest failure mode. Mitigation: validate
   willingness to pay *before* building the billing stack out further —
   the credit system already exists, so this is a pricing-page and
   conversation problem, not an engineering one.
3. **Open-sourcing the engine helps a competitor.** Real but modest: the
   engine is the commodity half; the editor and sync layer are the product.
4. **Manim's gravity.** The math-animation community is Python and deeply
   invested. A TypeScript engine is a better fit for browser + agent
   workflows, but it's a migration ask.

## What to validate next (cheapest first)

1. Talk to 10 people who *make* explanatory math video — YouTubers, course
   creators, edtech producers. Ask what they pay for today and what they'd
   pay for. This single step de-risks the whole strategy.
2. Publish the engine and a 3b1b-style demo reel; measure whether the
   math/education community engages. Adoption of the OSS engine is the
   leading indicator for the hosted product.
3. Only then decide whether to broaden past math into general explanatory
   video (where the budget is) or stay narrow.
