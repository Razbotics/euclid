-- Application tables. Better Auth tables are generated separately:
--   npx @better-auth/cli generate  (from apps/api, then apply to D1)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The human-in-the-loop gate (plans/010). While 1 (the default), paid
  -- generation must fit a human-approved plan's roster and remaining budget;
  -- set_review_mode / the editor toggle it. The plans themselves live in the
  -- project's Durable Object, beside the decisions that approve them.
  review_mode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger (user_id, created_at DESC);

-- Binary files owned by a USER, linked into projects (plans/010 phase 4).
-- Rows are immutable — a new upload mints a new id, so `assetId` references
-- inside a document never go stale, and the same asset can safely be linked
-- into several projects. `project_id` remains as the *home* project (where
-- the file was created) during the migration; project membership itself
-- lives in `project_assets`.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  -- The owner. Tenancy checks this directly; the old join through projects
  -- remains only as a COALESCE fallback for rows created before the column.
  user_id TEXT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- audio | video | image
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_sec REAL,         -- audio/video only; NULL for images
  path TEXT,                 -- virtual path, e.g. /narration/scene-1.mp3; folders are derived
  created_at INTEGER NOT NULL,
  -- Probed from the bytes by the render worker, which is the only process with
  -- ffprobe (a Cloudflare Worker has none). NULL means "not measured", which
  -- is why probed_at exists separately: an image legitimately has no duration,
  -- and without a timestamp that is indistinguishable from an unprobed file
  -- and would be re-probed forever.
  width INTEGER,
  height INTEGER,
  fps REAL,                  -- video only
  probed_at INTEGER,
  -- Shot boundaries, as a JSON array of seconds. Separate from the probe
  -- above because the costs are nothing alike: probing reads a header, while
  -- detecting shots decodes the whole video. A file can be measured long
  -- before it has been watched.
  shots TEXT,
  shots_at INTEGER,
  -- A low-resolution, densely-keyframed re-encode the **editor** scrubs. The
  -- export and preview_frames never touch it: they read r2_key, so a proxy can
  -- never reach the finished video.
  --
  -- proxy_at without proxy_key is a settled row that stores nothing — either
  -- the source was already small enough or the transcode failed. Which one is
  -- derived from the row by needsProxy(), not recorded here, because a missing
  -- proxy has no consequence beyond a slower scrub.
  proxy_key TEXT,
  proxy_bytes INTEGER,
  proxy_at INTEGER,
  -- Where the asset stands with the human (plans/010). Provenance sets the
  -- initial value: owner uploads, render outputs and human-authored narration
  -- are born 'approved'; generated files are born 'pending' while the project
  -- is in review mode. Answering a review decision moves it; 'rejected' rows
  -- are kept, because the lineage is the record of what was turned down.
  review_status TEXT NOT NULL DEFAULT 'approved',
  review_note TEXT,
  reviewed_at INTEGER,
  reviewed_via TEXT,           -- editor | agent | chat | auto
  -- The asset this one iterates on; a chain of rows is the version history.
  revises TEXT,
  -- Narration only: hash of (voiceId, script text). Re-synthesis of text the
  -- human already approved auto-approves by matching this — the review is of
  -- the script, not the bytes.
  tts_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_path ON assets (project_id, path);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets (user_id, created_at DESC);

-- Which projects an asset appears in, with the per-project virtual path (the
-- same file can be /refs/logo.png here and /branding/logo.png there). An
-- asset's last link going away is what deletes its bytes; an asset linked
-- elsewhere survives its home project's deletion.
CREATE TABLE IF NOT EXISTS project_assets (
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  path TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_links_asset ON project_assets (asset_id);
-- The worker's probe queue: everything never measured, oldest first.
CREATE INDEX IF NOT EXISTS idx_assets_unprobed ON assets (probed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_unshot ON assets (shots_at, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_unproxied ON assets (proxy_at, created_at);

-- Generative asset requests handed to a provider (fal today).
--
-- There is no worker draining this: the provider holds the request in *its*
-- queue, and `request_id` plus the two URLs are how we collect it later. So a
-- row here is bookkeeping — which project asked, what it cost, what it became —
-- rather than a work queue.
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,       -- 'fal'
  model TEXT NOT NULL,          -- roster name, e.g. flux-schnell
  kind TEXT NOT NULL,           -- image | video | audio | model
  status TEXT NOT NULL,         -- pending | done | failed
  cost INTEGER NOT NULL,
  prompt TEXT,
  request_id TEXT NOT NULL,
  status_url TEXT NOT NULL,
  response_url TEXT NOT NULL,
  asset_id TEXT,                -- set once the bytes are stored
  error TEXT,
  -- Which plan revision's budget this generation drew down (plans/010), so a
  -- failure discovered minutes later during a poll refunds the budget where
  -- it came from. NULL when the project was not in review mode.
  plan_id TEXT,
  -- The asset this generation iterates on; copied onto the stored asset row
  -- when the file lands, so the review UI can show versions side by side.
  revises TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_project ON generation_jobs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL, -- queued | rendering | done | failed
  cost INTEGER NOT NULL,
  output_key TEXT,      -- R2 key of the finished mp4
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON render_jobs (project_id, created_at DESC);
