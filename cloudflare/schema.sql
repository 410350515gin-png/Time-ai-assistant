-- Cloudflare D1 schema for Time AI Assistant
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_plans (
  line_user_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  first_step TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  start_time TEXT,
  due_time TEXT,
  remind_at TEXT,
  estimated_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status
ON tasks(line_user_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_due
ON tasks(due_time);

CREATE INDEX IF NOT EXISTS idx_tasks_remind
ON tasks(remind_at);
