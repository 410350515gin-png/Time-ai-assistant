# 觀測方式：怎麼知道 bot 健不健康

> 對應程式版本：`main` `1a64df4`（PR #2 之後）。程式改了觀測點時，這份文件要一起更新。
> 隱私原則：log 和下面的查詢都不含使用者原文和任務標題，只有 id、數量和時間。

## 三種工具

| 工具 | 看什麼 | 怎麼用 |
|---|---|---|
| `/diag`、`/diag/reminders` | 整體健康狀態、push 用量、提醒佇列 | `curl` 帶上 `ADMIN_TOKEN` |
| Workers Logs | 每個事件的處理路徑與耗時、AI 判斷、錯誤 | Cloudflare dashboard → Workers → time-ai-assistant → **Logs**；或用 `wrangler tail` 看即時 log |
| D1 查詢 | 提醒有沒有送出、晚間回顧有沒有送出／有沒有回應、事件有沒有卡住 | `npx wrangler d1 execute time-ai-assistant-db --remote --command "…"` |

先設好環境變數，下面的指令就能直接複製：
```bash
export BOT=https://time-ai-assistant.410350515gin.workers.dev
export ADMIN_TOKEN=…   # 從密碼管理器貼上
```

---

## 1. `/diag`：整體健康檢查

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" $BOT/diag
```

| 欄位 | 健康時應該是 | 不對的話 |
|---|---|---|
| `secrets.*` | 全部 `true` | 少哪個就用 `wrangler secret put` 補 |
| `db.ok` | `true` | D1 binding 或 schema 有問題 |
| `gemini.ok` / `gemini.ms` | `true`，通常幾秒內 | 看 `gemini.failures`：401/403 是金鑰問題，429 是額度用完 |
| `line.ok` | `true` | `CHANNEL_ACCESS_TOKEN` 失效 |
| `push_usage.this_month_total` | 遠低於方案額度（輕用量 200 則） | 看 `by_purpose` 是哪一類用最多 |
| `push_usage.by_purpose.reply_fallback` | 應該很少 | 偏高代表常常超過 reply token 的時效，可能是 Queue 或 AI 太慢 |

不帶 token 會回 404，這是正常的設計。注意：每打一次 `/diag` 都會呼叫一次 Gemini。

## 2. `/diag/reminders`：提醒佇列

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" $BOT/diag/reminders
```

| 欄位 | 意思 | 健康時應該是 |
|---|---|---|
| `pending_with_reminder` | 還沒送出的提醒總數 | 任意 |
| `due_now` | 時間已經到、但還沒送出的 | `0`，或只在剛到點的那一分鐘內短暫大於 0 |
| `sending_now` | 已經 claim、正在送的 | 通常是 `0` |
| `next_reminder_at` | 下一則提醒的時間（UTC） | 跟你預期的一致 |

**`due_now` 連續好幾分鐘大於 0，就代表 cron 沒在跑，或推播一直失敗**，接著看第 4 節的查詢和 log 裡的 `Reminder push failed`。

## 3. Workers Logs：事件路徑與錯誤

即時看 log：
```bash
cd cloudflare
npx wrangler tail --format pretty                                  # 全部
npx wrangler tail --format pretty --search "Event processed"       # 只看事件處理
npx wrangler tail --format pretty --search "failed"                # 只看錯誤
```

### 每個事件一筆 `Event processed`
| 欄位 | 意思 | 判讀 |
|---|---|---|
| `path` | `inline`（webhook 背景處理按鈕）或 `queue` | 按鈕應該大多是 `inline` |
| `via` | `reply`（免費）或 `push`（佔額度） | 按鈕應該幾乎都是 `reply` |
| `handle_ms` | 處理耗時 | 按鈕通常 < 1000 |
| `queue_wait_ms` | 從進 Queue 到開始處理的時間 | 打字訊息的排隊延遲 |
| `replayed` | `true` 代表是補送先前已處理完的回覆 | 偶爾出現正常；經常出現代表送出常常失敗 |

### 每次 AI 判斷一筆 `AI decision`
`intent`、`task_ids`、`candidates.recent_reminders / last_task / quoted_task`、`candidates.quote_resolution`、`fallback`、`ai_ms`。
- 「還沒」被判錯時，先看 `intent` 和候選任務對不對。
- `quote_resolution = quoted_overrides_ai` 代表 AI 選錯任務，被引用回覆的規則修正回來了。
- `fallback: true` 代表 AI 不可用，使用者收到的是「這次先不動你的任務」。

### 要特別留意的錯誤
| 訊息 | 代表什麼 |
|---|---|
| `Queue enqueue failed` | Queue 不可用；webhook 會回 503 讓 LINE 重送 |
| `Inline processing failed; delayed queue backup will retry` | 按鈕處理失敗，約 5 秒後由 Queue 備份重試 |
| `Queue processing failed` | Queue 處理失敗，會自動 retry；重試 3 次都失敗會進 DLQ（`gemini-tasks-dlq`） |
| `Reminder push failed` / `Evening check-in push failed` | 推播失敗；`permanent: true` 代表不會再重試（例如使用者封鎖了 bot） |
| `Gemini exhausted` | 所有模型都失敗 |
| `Cron failed` | 整個 cron 失敗 |

Cloudflare 的 invocation log 也要看：`POST /callback` 的 **`outcome` 必須是 `ok`**，`wallTimeMs` 應該遠低於 2000。再出現 `canceled` 就代表 webhook 又回應太慢（見 [incident 紀錄](incidents/2026-10-24-webhook-cancellation.md)）。

## 4. D1 查詢：提醒、晚間回顧、事件狀態

用法：`npx wrangler d1 execute time-ai-assistant-db --remote --command "<SQL>"`
（時間欄位：`created_at` / `sent_at` 這類是 D1 的 UTC 格式，加 8 小時就是台灣時間；`remind_at` 是 ISO 格式。）

### 提醒有沒有準時送出
```sql
-- 已經過期超過 5 分鐘還沒送出（應該是 0）
SELECT COUNT(*) AS overdue FROM tasks
WHERE status='pending' AND reminder_sent_at IS NULL
  AND remind_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes');

-- claim 卡住（應該是 0；超過 5 分鐘會自動被重新 claim）
SELECT COUNT(*) AS stuck_claims FROM tasks
WHERE reminder_sent_at IS NULL AND reminder_claimed_at < datetime('now','-5 minutes');

-- 最近 7 天每天送出幾則提醒（台灣日期）
SELECT date(created_at,'+8 hours') AS day, COUNT(*) AS reminders
FROM task_events WHERE event_type='reminder_sent'
GROUP BY day ORDER BY day DESC LIMIT 7;
```

### 晚間回顧（22:30）
```sql
-- 今天：送出幾人、回應幾人、卡在 claim 幾人
SELECT
  SUM(sent_at IS NOT NULL) AS sent,
  SUM(mood IS NOT NULL) AS answered_mood,
  SUM(emotion_tag IS NOT NULL) AS answered_emotion,
  SUM(sent_at IS NULL AND claimed_at IS NOT NULL) AS claimed_not_sent
FROM daily_checkins WHERE date_key = date('now','+8 hours');
```
健康狀態：22:40 之後 `sent` 等於最近 30 天有互動的使用者人數，`claimed_not_sent` 是 0。

### Webhook 事件有沒有卡住
```sql
-- 最近 1 天各狀態數量（done 應該佔絕大多數）
SELECT status, owner, COUNT(*) AS n FROM webhook_events
WHERE created_at >= datetime('now','-1 day') GROUP BY status, owner;

-- 卡在 processing / handled 超過 5 分鐘（應該是 0）
SELECT COUNT(*) AS stuck FROM webhook_events
WHERE status IN ('processing','handled') AND updated_at < datetime('now','-5 minutes')
  AND created_at >= datetime('now','-1 day');
```

### Push 用量（成本）
```sql
SELECT date_key, purpose, count FROM push_usage ORDER BY date_key DESC, purpose LIMIT 30;
```
purpose：`reminder`（提醒）、`evening`（晚間回顧）、`reply_fallback`（reply 失效改用 push）。

### 卡住介入有沒有被使用（產品指標）
```sql
SELECT event_type, COUNT(*) AS n FROM task_events
WHERE created_at >= datetime('now','-7 days')
  AND event_type IN ('stuck','barrier','micro_start','step_done','completed','snoozed','deferred')
GROUP BY event_type ORDER BY n DESC;
```

---

## 目前已知的觀測缺口
1. **提醒和晚間回顧「送出成功」時沒有 log**，只有失敗才有。要確認有沒有送出，只能用第 4 節的查詢，或看 `push_usage`。之後可以補一行成功 log（只記 task id 或人數）。
2. `/diag` 沒有晚間回顧的統計，要用 D1 查詢。
3. 沒有自動告警：pilot 期間每天手動檢查一次（見 [`pilot-checklist.md`](pilot-checklist.md)）。
4. `/diag` 每打一次都會呼叫一次 Gemini，不適合拿來當高頻率的健康檢查。
