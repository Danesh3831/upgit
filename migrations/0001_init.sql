-- Migration 0001 — hermes-mini initial schema
-- All timestamps are stored as ISO-8601 UTC strings.
-- The "calendar day" of a task (task_day) is a 'YYYY-MM-DD' string computed
-- in the Worker using the Asia/Tehran timezone (UTC+03:30, no DST since 2022).

-- =============================================
-- Daily tasks
-- =============================================
CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT    NOT NULL,
    task_text     TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    task_day      TEXT    NOT NULL,             -- 'YYYY-MM-DD' in Asia/Tehran time
    created_at    TEXT    NOT NULL,             -- ISO-8601 UTC
    completed_at  TEXT                           -- ISO-8601 UTC (NULL while pending)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_day  ON tasks (user_id, task_day);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks (user_id, status);

-- =============================================
-- Short-term conversation memory
-- (only message text of the whitelisted user; pruned by the Worker
--  to keep the last N turns)
-- =============================================
CREATE TABLE IF NOT EXISTS conversation_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversation_history (user_id, id);

-- =============================================
-- Telegram update_id deduplication
-- (Telegram retries webhook deliveries; this table guarantees
--  at-most-once processing per update_id)
-- =============================================
CREATE TABLE IF NOT EXISTS processed_updates (
    update_id    INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL
);
