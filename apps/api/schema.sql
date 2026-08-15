-- Application tables. Better Auth tables are generated separately:
--   npx @better-auth/cli generate  (from apps/api, then apply to D1)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
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

-- Binary files owned by a project: narration audio now, video/image clips in
-- the general-video phase. Rows are immutable — a new upload mints a new id,
-- so `assetId` references inside a document never go stale.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- audio | video | image
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_sec REAL,         -- audio/video only; NULL for images
  path TEXT,                 -- virtual path, e.g. /narration/scene-1.mp3; folders are derived
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_path ON assets (project_id, path);

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
