-- Cloudflare D1 schema for 豬豬行程小秘書（與 src/index.js 的 SCHEMA_STATEMENTS 同步）
-- 全新資料庫：wrangler d1 execute time-ai-assistant-db --remote --file=schema.sql
-- 既有資料庫不用手動跑：Worker 每個 isolate 第一次啟動時會自動補欄位（可重複執行）。

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'done',
  owner TEXT,
  reply_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  last_task_id INTEGER,
  last_task_at TEXT,
  default_lead_minutes INTEGER,
  last_prompt_json TEXT,
  last_bot_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
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
  recurrence_json TEXT,
  task_type TEXT NOT NULL DEFAULT 'daily',
  stuck_count INTEGER NOT NULL DEFAULT 0,
  last_barrier TEXT,
  parent_id INTEGER,
  step_index INTEGER,
  session_at TEXT,
  lead_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  reminder_sent_at TEXT,
  reminder_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  line_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_value TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  line_user_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  mood TEXT,
  emotion_tag TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  responded_at TEXT,
  PRIMARY KEY(line_user_id, date_key)
);

CREATE TABLE IF NOT EXISTS bot_messages (
  message_id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_usage (
  date_key TEXT NOT NULL,
  purpose TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(date_key, purpose)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(line_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_time);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_user_type ON task_events(line_user_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id, step_index);
