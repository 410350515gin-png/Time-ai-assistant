import { REWARD_IMAGES_BASE64 } from "./rewardImages.js";

/* =========================================================================
 * 豬豬行程小秘書 — Cloudflare Worker
 *
 * 原則：AI 負責理解自然語言，程式負責可靠執行。
 *
 * 事件處理流程：
 *   LINE webhook
 *     ├─ 按鈕 / 系統指令 / 確認字（決定性操作）→ 直接在 webhook 的 waitUntil 處理（快、可用 reply token）
 *     │     └─ 若需要 AI 或處理失敗 → 送進 Queue
 *     └─ 一般文字 → Queue（先顯示「輸入中」動畫）→ Gemini → 程式驗證 → D1 → 回覆
 *
 * 冪等：webhook_events.status = processing → handled（已執行副作用、回覆已存）→ done（已送達）
 *   retry 時：handled 只補送回覆，不重做副作用；done 直接略過。
 * ========================================================================= */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const YES = new Set(["是","好","確認","確認執行","同意","可以","ok","yes","好啊","照這個安排","確認計畫","好呀🐽","好呀","確定刪除🗑️"]);
const NO = new Set(["否","不要","取消","不用","no","先不要","不接受","先不要🙈"]);
const MODIFY = new Set(["修改","我要改","我要修改","調整","我要改✏️"]);

const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;          // 台灣沒有日光節約時間，固定 +08:00
const PENDING_PLAN_TTL_MINUTES = 30;                 // 待確認方案逾時
const REPLY_TOKEN_SAFE_MS = 50 * 1000;               // reply token 只在事件後短時間內有效，超過就改用 push
const EVENT_LEASE_MS = 90 * 1000;                    // 同一事件被其他執行中的 worker 處理時的租約
const GEMINI_TOTAL_DEADLINE_MS = 20 * 1000;          // 一次 AI 理解的總時間上限
const LAST_TASK_CONTEXT_MINUTES = 30;                // 「剛剛在聊的任務」指標有效時間
const RICH_MENU_NAME = "Pig Secretary Task Book v2";
const RICH_MENU_SETTING_KEY = "default_rich_menu_id_v2";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 診斷與管理端點：必須帶 ADMIN_TOKEN，否則一律當作不存在。
    if (url.pathname.startsWith("/diag") || url.pathname.startsWith("/admin")) {
      if (!isAdminRequest(request, env)) return new Response("Not Found", { status: 404 });
      if (request.method === "GET" && url.pathname === "/diag") return runDiagnostics(env);
      if (request.method === "GET" && url.pathname === "/diag/reminders") return runReminderDiagnostics(env);
      if (request.method === "POST" && url.pathname === "/admin/setup-rich-menu") {
        try {
          const id = await ensurePigRichMenu(env, { force: true });
          return json({ ok: true, richMenuId: id });
        } catch (err) {
          return json({ ok: false, error: String(err?.message || err) }, 500);
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ok", runtime: "cloudflare-workers", version: "0.3", db_bound: Boolean(env.DB) });
    }

    const rewardMatch = url.pathname.match(/^\/reward-images\/(\d+)\.jpg$/);
    if (request.method === "GET" && rewardMatch) {
      const index = Number(rewardMatch[1]) - 1;
      const base64 = REWARD_IMAGES_BASE64[index];
      if (!base64) return new Response("Not Found", { status: 404 });

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    if (request.method === "POST" && (url.pathname === "/callback" || url.pathname === "/webhook")) {
      return handleLineWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchemaOnce(env.DB);
      await Promise.all([
        processDueReminders(env, controller.scheduledTime),
        processEveningCheckins(env, controller.scheduledTime)
      ]);
    })().catch(err => {
      console.error("Cron failed", { name: err?.name || null, message: err?.message || String(err) });
    }));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const body = message.body || {};
        if (body.type !== "LINE_EVENT" || !body.event) {
          console.warn("Unknown queue message", { type: body.type || null });
          message.ack();
          continue;
        }

        await processLineEvent(body.event, env, { allowAi: true, enqueuedAt: body.enqueued_at || null });
        message.ack();
      } catch (err) {
        console.error("Queue processing failed", {
          name: err?.name || null,
          message: err?.message || String(err),
          attempts: message.attempts || null
        });
        message.retry({ delaySeconds: err?.retryDelaySeconds || 30 });
      }
    }
  }
};

function isAdminRequest(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const header = request.headers.get("authorization") || "";
  return timingSafeEqual(header, `Bearer ${token}`);
}

/* ------------------------------------------------------------------------- *
 * Webhook
 * ------------------------------------------------------------------------- */

async function handleLineWebhook(request, env, ctx) {
  const raw = await request.text();
  const signature = request.headers.get("x-line-signature") || "";

  if (!env.CHANNEL_SECRET || !env.CHANNEL_ACCESS_TOKEN || !env.GEMINI_API_KEY) {
    return json({ error: "missing secrets" }, 500);
  }

  const valid = await verifyLineSignature(raw, signature, env.CHANNEL_SECRET);
  if (!valid) {
    console.error("LINE signature invalid");
    return json({ error: "invalid signature" }, 400);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const events = Array.isArray(body.events) ? body.events : [];

  if (env.DB && env.CHANNEL_ACCESS_TOKEN) {
    ctx.waitUntil(
      ensurePigRichMenu(env).catch(err => {
        console.error("Rich Menu bootstrap failed", { message: err?.message || String(err) });
      })
    );
  }

  if (!env.GEMINI_QUEUE) {
    console.error("GEMINI_QUEUE binding missing");
    return json({ error: "queue unavailable" }, 503);
  }

  const inline = [];
  const queued = [];
  for (const event of events) {
    if (!isSupportedEvent(event)) continue;
    (isDeterministicCandidate(event) ? inline : queued).push(event);
  }

  // 需要 AI 的事件在回應 LINE 之前就送進 Queue：失敗時回 503，讓 LINE 重送（需在 LINE Console 開啟 webhook redelivery）。
  if (queued.length) {
    try {
      await enqueueEvents(env, queued);
    } catch (err) {
      console.error("Queue enqueue failed", { message: err?.message || String(err) });
      return json({ error: "queue enqueue failed" }, 503);
    }
    for (const event of queued) ctx.waitUntil(startLoadingAnimation(env, event));
  }

  // 決定性操作直接處理，速度快且通常可以用免費的 reply。
  for (const event of inline) ctx.waitUntil(runInline(event, env));

  return json({ status: "ok", inline: inline.length, queued: queued.length });
}

function isSupportedEvent(event) {
  const isText = event?.type === "message" && event?.message?.type === "text";
  const isPostback = event?.type === "postback" && typeof event?.postback?.data === "string";
  const isFollow = event?.type === "follow";
  return (isText || isPostback || isFollow) && Boolean(event?.source?.userId);
}

function eventText(event) {
  if (event?.type === "postback") return String(event.postback.data || "").trim();
  if (event?.type === "message") return String(event.message.text || "").trim();
  return "";
}

/** 不需要 AI 就可能處理完的事件：按鈕、系統指令、確認字。 */
function isDeterministicCandidate(event) {
  if (event.type === "follow" || event.type === "postback") return true;
  const text = eventText(event);
  const lower = text.toLowerCase();
  return text.startsWith("系統：") || text === "查看所有任務" || YES.has(lower) || NO.has(lower) || MODIFY.has(lower);
}

async function enqueueEvents(env, events) {
  const now = Date.now();
  await env.GEMINI_QUEUE.sendBatch(events.map(event => ({
    body: { type: "LINE_EVENT", event, enqueued_at: now }
  })));
}

async function runInline(event, env) {
  try {
    const outcome = await processLineEvent(event, env, { allowAi: false });
    if (outcome === "needs_ai") {
      await startLoadingAnimation(env, event);
      await enqueueEvents(env, [event]);
    }
  } catch (err) {
    console.error("Inline processing failed; falling back to queue", { message: err?.message || String(err) });
    try {
      await enqueueEvents(env, [event]);
    } catch (enqueueErr) {
      console.error("Fallback enqueue failed; event may be lost", { message: enqueueErr?.message || String(enqueueErr) });
    }
  }
}

/* ------------------------------------------------------------------------- *
 * 事件處理（inline 與 queue 共用）
 * 回傳 "done" | "skipped" | "needs_ai"
 * ------------------------------------------------------------------------- */

async function processLineEvent(event, env, { allowAi, enqueuedAt = null }) {
  if (!isSupportedEvent(event)) return "skipped";
  if (!env.DB) throw new Error("D1 binding missing");

  const started = Date.now();
  const uid = event.source.userId;
  const eventId = event.webhookEventId || null;

  await ensureSchemaOnce(env.DB);

  const claim = await beginEvent(env.DB, eventId, { inline: !allowAi });
  if (claim.state === "done" || claim.state === "busy_skip") return "skipped";

  let reply = claim.reply;
  if (claim.state !== "handled") {
    try {
      if (event.type === "follow") {
        await ensureUser(env.DB, uid);
        reply = buildWelcomeMessage();
      } else {
        const text = eventText(event);
        if (!text) {
          await finishEvent(env.DB, eventId);
          return "skipped";
        }
        const meta = {
          quotedMessageId: event?.message?.quotedMessageId || null,
          isPostback: event.type === "postback"
        };
        reply = await handleDeterministic(uid, text, env, meta);
        if (reply === null) {
          if (!allowAi) {
            await releaseEvent(env.DB, eventId); // 交給 queue，queue 不用等租約過期
            return "needs_ai";
          }
          reply = await handleAiMessage(uid, text, env, meta);
        }
      }
    } catch (err) {
      await releaseEvent(env.DB, eventId).catch(() => {});
      throw err;
    }
    await markEventHandled(env.DB, eventId, reply);
  }

  const handledAt = Date.now();
  const via = await deliver(env, uid, reply, event.replyToken, event.timestamp, eventId);
  await finishEvent(env.DB, eventId);

  console.log("Event processed", {
    path: allowAi ? "queue" : "inline",
    type: event.type,
    queue_wait_ms: enqueuedAt ? started - enqueuedAt : null,
    handle_ms: handledAt - started,
    deliver_ms: Date.now() - handledAt,
    via,
    replayed: claim.state === "handled"
  });
  return "done";
}

async function beginEvent(db, eventId, { inline }) {
  if (!eventId) return { state: "new", reply: null };

  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO webhook_events(event_id,status,updated_at) VALUES (?,'processing',CURRENT_TIMESTAMP)"
  ).bind(eventId).run();
  if (Number(inserted?.meta?.changes || 0) > 0) return { state: "new", reply: null };

  const row = await db.prepare(
    `SELECT status, reply_json,
            (julianday('now') - julianday(updated_at)) * 86400000 AS age_ms
     FROM webhook_events WHERE event_id=?`
  ).bind(eventId).first();

  const status = row?.status || "done";
  if (status === "done") return { state: "done", reply: null };

  if (status === "handled") {
    let reply = null;
    try { reply = JSON.parse(row.reply_json); } catch { reply = null; }
    if (reply !== null) return { state: "handled", reply };
    return { state: "done", reply: null };
  }

  // status === "processing"：可能是別的 worker 正在處理，也可能是之前當掉。
  if (Number(row?.age_ms || 0) < EVENT_LEASE_MS) {
    if (inline) return { state: "busy_skip", reply: null };
    const err = new Error("event is being processed elsewhere");
    err.retryDelaySeconds = 60;
    throw err;
  }

  // 租約過期：接手重做。副作用 SQL 都有 status 條件，重做大多是安全的。
  await db.prepare("UPDATE webhook_events SET updated_at=CURRENT_TIMESTAMP WHERE event_id=?").bind(eventId).run();
  return { state: "takeover", reply: null };
}

/** 處理失敗或要轉交 queue 時放掉租約，讓下一個處理者可以立刻接手。 */
async function releaseEvent(db, eventId) {
  if (!eventId) return;
  await db.prepare(
    "UPDATE webhook_events SET updated_at='1970-01-01 00:00:00' WHERE event_id=? AND status='processing'"
  ).bind(eventId).run();
}

async function markEventHandled(db, eventId, reply) {
  if (!eventId) return;
  await db.prepare(
    "UPDATE webhook_events SET status='handled', reply_json=?, updated_at=CURRENT_TIMESTAMP WHERE event_id=?"
  ).bind(JSON.stringify(reply), eventId).run();
}

async function finishEvent(db, eventId) {
  if (!eventId) return;
  await db.prepare(
    "UPDATE webhook_events SET status='done', reply_json=NULL, updated_at=CURRENT_TIMESTAMP WHERE event_id=?"
  ).bind(eventId).run();
}

/* ------------------------------------------------------------------------- *
 * LINE 傳送
 * ------------------------------------------------------------------------- */

function lineApiBase(env) {
  return String(env.LINE_API_BASE || "https://api.line.me").replace(/\/$/, "");
}

function lineDataApiBase(env) {
  return String(env.LINE_DATA_API_BASE || "https://api-data.line.me").replace(/\/$/, "");
}

/**
 * 先試免費的 reply；token 過期或已用過才改用 push（push 會佔 LINE 每月訊息額度）。
 * reply 失敗是正常的退路，不算錯誤。push 帶由事件 id 決定的 retry key，重送不會變兩則。
 */
async function deliver(env, uid, message, replyToken, eventTimestamp, eventId = null) {
  const fresh = replyToken && Number.isFinite(Number(eventTimestamp)) &&
    Date.now() - Number(eventTimestamp) < REPLY_TOKEN_SAFE_MS;

  if (fresh) {
    try {
      const sent = await replyLine(env, replyToken, message);
      await recordSentMessages(env.DB, uid, message, sent);
      return "reply";
    } catch (err) {
      console.log("LINE reply unavailable; using push", { status: err?.status || null });
    }
  }

  const retryKey = eventId ? await deterministicUuid(`event-reply:${eventId}`) : null;
  const sent = await pushLine(env, uid, message, { retryKey, purpose: "reply_fallback" });
  await recordSentMessages(env.DB, uid, message, sent);
  return "push";
}

/**
 * @returns sentMessages 陣列；若 retry key 重複（409，代表 LINE 先前已收下這則）回傳 []。
 */
async function lineApiCall(env, path, payload, { retryKey = null } = {}) {
  const headers = { ...JSON_HEADERS, authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` };
  if (retryKey) headers["X-Line-Retry-Key"] = retryKey;

  const res = await fetch(`${lineApiBase(env)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (res.status === 409 && retryKey) {
    console.log("LINE push already accepted (retry key 409); treating as success", { path });
    return { sentMessages: [], duplicate: true };
  }
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`LINE ${path} ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  try {
    const data = await res.json();
    return { sentMessages: Array.isArray(data?.sentMessages) ? data.sentMessages : [], duplicate: false };
  } catch {
    return { sentMessages: [], duplicate: false };
  }
}

/**
 * purpose：reminder / evening / reply_fallback / system — 用來統計 push 用量（push_usage 表、/diag）。
 */
async function pushLine(env, to, message, { retryKey = null, purpose = "system" } = {}) {
  const r = await lineApiCall(env, "/v2/bot/message/push", { to, messages: toLineMessages(message) }, { retryKey });
  if (!r.duplicate) await recordPushUsage(env.DB, purpose);
  return r.sentMessages;
}

async function replyLine(env, replyToken, message) {
  const r = await lineApiCall(env, "/v2/bot/message/reply", { replyToken, messages: toLineMessages(message) });
  return r.sentMessages;
}

async function recordPushUsage(db, purpose) {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO push_usage(date_key,purpose,count) VALUES (?,?,1)
       ON CONFLICT(date_key,purpose) DO UPDATE SET count=count+1`
    ).bind(tpeDateKey(Date.now()), String(purpose)).run();
  } catch (err) {
    console.warn("recordPushUsage failed", { message: err?.message || String(err) });
  }
}

/** 由資料決定的 UUID（給 X-Line-Retry-Key 用）：同一個 seed 永遠得到同一個 key。 */
async function deterministicUuid(seed) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(seed))));
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 樣式
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 顯示「輸入中…」動畫（不佔訊息額度，bot 送出訊息時自動消失）。 */
async function startLoadingAnimation(env, event) {
  const uid = event?.source?.userId;
  if (!uid || event?.source?.type !== "user") return;
  try {
    await fetch(`${lineApiBase(env)}/v2/bot/chat/loading/start`, {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ chatId: uid, loadingSeconds: 20 })
    });
  } catch (err) {
    console.warn("Loading animation failed", { message: err?.message || String(err) });
  }
}

/**
 * 記錄「這則 bot 訊息是在講哪個任務」：
 * - bot_messages：使用者用 LINE「回覆」引用這則訊息時，可以決定性地找到任務
 * - users.last_task_id：「剛剛在聊的任務」指標，給 AI 當最強的情境提示
 */
async function recordSentMessages(db, uid, message, sentMessages) {
  const taskId = message && typeof message === "object" ? Number(message.taskId) : NaN;
  if (!db || !Number.isInteger(taskId)) return;
  try {
    const kind = String(message.kind || "task");
    const stmts = (sentMessages || [])
      .filter(m => m && m.id)
      .map(m => db.prepare(
        "INSERT OR IGNORE INTO bot_messages(message_id,line_user_id,task_id,kind) VALUES (?,?,?,?)"
      ).bind(String(m.id), uid, taskId, kind));
    stmts.push(db.prepare(
      `INSERT INTO users(line_user_id,last_task_id,last_task_at) VALUES (?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(line_user_id) DO UPDATE SET last_task_id=excluded.last_task_id, last_task_at=excluded.last_task_at`
    ).bind(uid, taskId));
    await db.batch(stmts);
  } catch (err) {
    console.warn("recordSentMessages failed", { message: err?.message || String(err) });
  }
}

function toLineTextMessage(message) {
  if (message && typeof message === "object") {
    const out = { type: "text", text: String(message.text || "").slice(0, 5000) };
    if (message.quickReply) out.quickReply = message.quickReply;
    return out;
  }
  return { type: "text", text: String(message || "").slice(0, 5000) };
}

function toLineMessages(message) {
  const messages = [];

  if (message && typeof message === "object" && message.flex) {
    messages.push({
      type: "flex",
      altText: String(message.text || "任務中心").slice(0, 400),
      contents: message.flex,
      ...(message.quickReply ? { quickReply: message.quickReply } : {})
    });
  } else {
    messages.push(toLineTextMessage(message));
  }

  if (message && typeof message === "object" && message.rewardImageUrl) {
    messages.push({
      type: "image",
      originalContentUrl: message.rewardImageUrl,
      previewImageUrl: message.rewardImageUrl
    });
  }
  return messages;
}

/* ------------------------------------------------------------------------- *
 * 決定性操作：按鈕、系統指令、待確認方案的確認字
 * 回傳 reply；回傳 null 代表需要交給 AI。
 * ------------------------------------------------------------------------- */

async function handleDeterministic(uid, text, env, meta = {}) {
  const db = env.DB;
  await ensureUser(db, uid);
  const s = String(text || "").trim();
  const lower = s.toLowerCase();

  // 方案按鈕（帶 plan id，只能確認「這一份」方案，舊按鈕不會誤觸新方案）
  const planButton = s.match(/^系統：(確認|取消|修改)方案:([A-Za-z0-9-]{4,40})$/u);
  if (planButton) {
    const pending = await getPendingPlan(db, uid);
    if (!pending || pending.id !== planButton[2]) {
      return "這個方案已經過期或處理過了🐽 有需要再跟我說一次就好。";
    }
    if (planButton[1] === "確認") return executePendingPlan(env, uid, pending);
    if (planButton[1] === "取消") {
      await clearPendingPlan(db, uid);
      return "好～這次先不執行🙈";
    }
    return "可以呀✏️ 直接用你平常說話的方式告訴我想怎麼改。";
  }

  // 手打的確認字：只在「還沒過期」的待確認方案存在時才有效
  if (YES.has(lower) || NO.has(lower) || MODIFY.has(lower)) {
    const pending = await getPendingPlan(db, uid);
    if (pending) {
      if (YES.has(lower)) return executePendingPlan(env, uid, pending);
      if (NO.has(lower)) {
        await clearPendingPlan(db, uid);
        return "好～這次先不執行🙈";
      }
      return "可以呀✏️ 直接用你平常說話的方式告訴我想怎麼改。";
    }
    return null; // 沒有待確認方案 → 當一般對話交給 AI
  }

  return handleFastPath(uid, s, env, meta);
}

async function executePendingPlan(env, uid, pending) {
  const db = env.DB;

  if (pending.action === "delete_all") {
    const r = await db.prepare(
      "UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE line_user_id=? AND status IN ('pending','paused')"
    ).bind(uid).run();
    await clearPendingPlan(db, uid);
    return `🗑️ 已移除 ${Number(r?.meta?.changes || 0)} 項待辦任務，後續提醒也會停止。`;
  }

  if (pending.action === "delete_tasks") {
    const ids = Array.isArray(pending.task_ids) ? pending.task_ids.filter(Number.isInteger) : [];
    await clearPendingPlan(db, uid);
    if (!ids.length) return "找不到要刪除的任務。";
    const placeholders = ids.map(() => "?").join(",");
    const r = await db.prepare(
      `UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
       WHERE line_user_id=? AND status IN ('pending','paused') AND id IN (${placeholders})`
    ).bind(uid, ...ids).run();
    return `🗑️ 已移除 ${Number(r?.meta?.changes || 0)} 項任務，之後不會再提醒。`;
  }

  // 存方案前重新驗證時間：方案可能是幾分鐘前提的，提醒時間不能已經過去。
  const original = sanitizePlanItems(pending.plan_items);
  const hadReminder = original.filter(x => x.remind_at || x.recurrence).length;
  const items = original.map(validatePlanTimes).filter(Boolean).map(fillRecurringFirstReminder);
  const keptReminder = items.filter(x => x.remind_at).length;

  const saved = await savePlanTasks(db, uid, items);
  await clearPendingPlan(db, uid);

  const lostReminders = Math.max(0, hadReminder - keptReminder);
  const note = lostReminders
    ? `\n⚠️ 有 ${lostReminders} 個提醒時間已經過了，我先存成沒有提醒的任務；要的話再跟我說新的時間。`
    : "";
  return `✅ 好呀🐽 已經幫你存好 ${saved} 項任務。${note}\n之後可以直接跟我說「列出任務」或告訴我哪一項完成了。`;
}

async function handleFastPath(uid, s, env, meta = {}) {
  const db = env.DB;

  if (s === "系統：列出任務" || s === "查看所有任務" || s === "系統：任務首頁") {
    return buildTaskHubMessage();
  }

  const categoryMatch = s.match(/^系統：任務分類:(routine|goal|daily)$/u);
  if (categoryMatch) return listTasksByType(db, uid, categoryMatch[1]);

  if (s === "系統：改待確認分類") {
    const pending = await getPendingPlan(db, uid);
    const items = Array.isArray(pending?.plan_items) ? pending.plan_items : [];
    if (items.length !== 1) return "這次有多個任務，直接跟我說哪一項要改成哪一類就好🐽";
    return categoryChoiceMessage(items[0].title, "pending");
  }

  const pendingType = s.match(/^系統：設定待確認分類:(routine|goal|daily)$/u);
  if (pendingType) {
    const pending = await getPendingPlan(db, uid);
    const items = Array.isArray(pending?.plan_items) ? pending.plan_items : [];
    if (items.length !== 1) return "找不到可以修改的待確認任務🐽";
    items[0].task_type = items[0].recurrence ? "routine" : pendingType[1];
    const saved = await setPendingPlan(db, uid, { ...pending, plan_items: items });
    return withPlanActions(
      `改好啦🐽\n📌 ${items[0].title}\n🏷️ ${taskTypeLabel(items[0].task_type)}\n\n確認沒問題就存起來～`,
      saved.id,
      true
    );
  }

  const changeType = s.match(/^系統：改分類:(\d+)$/u);
  if (changeType) {
    const id = Number(changeType[1]);
    const task = await db.prepare(
      "SELECT id,title FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    return categoryChoiceMessage(task.title, id);
  }

  const setType = s.match(/^系統：設定分類:(\d+):(routine|goal|daily)$/u);
  if (setType) {
    const id = Number(setType[1]);
    const type = setType[2];
    const task = await db.prepare(
      "UPDATE tasks SET task_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status IN ('pending','paused') RETURNING id,title"
    ).bind(type, id, uid).first();
    return task
      ? `改好啦🐽 「${task.title}」已移到 ${taskTypeLabel(type)} 任務。`
      : "找不到這項待辦了🐽";
  }

  const mood = s.match(/^系統：晚間心情:(\d{4}-\d{2}-\d{2}):(great|good|neutral|tired|low)$/u);
  if (mood) {
    const dateKey = mood[1];
    const value = mood[2];
    await db.prepare(
      `INSERT INTO daily_checkins(line_user_id,date_key,mood,responded_at)
       VALUES (?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(line_user_id,date_key) DO UPDATE
       SET mood=excluded.mood, responded_at=CURRENT_TIMESTAMP`
    ).bind(uid, dateKey, value).run();

    const labels = {
      great: "很不錯 😄",
      good: "還可以 🙂",
      neutral: "普通 😐",
      tired: "有點累 😮‍💨",
      low: "很低落 😞"
    };

    return {
      text: `記下來了🐽 今天是「${labels[value]}」。\n如果願意，再選一個今天最明顯的感受；不想填也可以直接收工。`,
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("✨ 有成就感", `系統：晚間情緒:${dateKey}:accomplished`, "✨ 今天有成就感") },
          { type: "action", action: hiddenPostbackAction("🌿 平靜", `系統：晚間情緒:${dateKey}:calm`, "🌿 今天比較平靜") },
          { type: "action", action: hiddenPostbackAction("😵‍💫 焦慮", `系統：晚間情緒:${dateKey}:anxious`, "😵‍💫 今天有點焦慮") },
          { type: "action", action: hiddenPostbackAction("🪫 疲累", `系統：晚間情緒:${dateKey}:exhausted`, "🪫 今天很疲累") },
          { type: "action", action: hiddenPostbackAction("😤 煩躁", `系統：晚間情緒:${dateKey}:irritable`, "😤 今天有點煩躁") },
          { type: "action", action: hiddenPostbackAction("🌧️ 低落", `系統：晚間情緒:${dateKey}:down`, "🌧️ 今天有點低落") },
          { type: "action", action: hiddenPostbackAction("收工🐽", `系統：晚間情緒:${dateKey}:skip`, "今天先到這裡 🐽") }
        ]
      }
    };
  }

  const emotion = s.match(/^系統：晚間情緒:(\d{4}-\d{2}-\d{2}):(accomplished|calm|anxious|exhausted|irritable|down|skip)$/u);
  if (emotion) {
    const dateKey = emotion[1];
    const tag = emotion[2];

    if (tag !== "skip") {
      await db.prepare(
        `INSERT INTO daily_checkins(line_user_id,date_key,emotion_tag,responded_at)
         VALUES (?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(line_user_id,date_key) DO UPDATE
         SET emotion_tag=excluded.emotion_tag, responded_at=CURRENT_TIMESTAMP`
      ).bind(uid, dateKey, tag).run();
    }

    const closings = {
      accomplished: "今天有做到一些對自己重要的事，這份進度值得看見✨",
      calm: "有一點平靜就很好，今晚先把今天放下吧🌿",
      anxious: "今天有點焦慮也沒關係，明天的事情明天再一起整理🐽",
      exhausted: "今天真的累了，今晚先休息，不用再補進度🪫",
      irritable: "今天有點煩躁，先讓這一天結束就好🐽",
      down: "今天比較低落，明天我會盡量把事情排得更輕一點🌧️",
      skip: "好，今天就到這裡🐽 晚安。"
    };

    return closings[tag] || "記下來了🐽 今天先到這裡。";
  }

  const stuck = s.match(/^系統：卡住任務:(\d+)$/u);
  if (stuck) {
    const task = await markTaskStuck(db, uid, Number(stuck[1]), "button");
    if (!task) return "找不到這項待辦了🐽";
    return buildStuckIntervention(task);
  }

  const barrier = s.match(/^系統：障礙:(\d+):(tired|unclear|time|avoid)$/u);
  if (barrier) {
    const id = Number(barrier[1]);
    const kind = barrier[2];
    const task = await db.prepare(
      `UPDATE tasks
       SET last_barrier=?, stuck_count=CASE WHEN COALESCE(stuck_count,0) < 2 THEN 2 ELSE stuck_count END, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=? AND status IN ('pending','paused')
       RETURNING id,title,first_step,due_time,task_type,stuck_count,last_barrier,recurrence_json`
    ).bind(kind, id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    await logTaskEvent(db, id, uid, "barrier", kind);
    return buildBarrierPlan(task, kind);
  }

  const microStart = s.match(/^系統：先做五分鐘:(\d+)$/u);
  if (microStart) {
    const id = Number(microStart[1]);
    const task = await db.prepare(
      "SELECT id,title,first_step FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    await logTaskEvent(db, id, uid, "micro_start", "5m");
    return {
      text: `好，就只做 5 分鐘🐽\n\n👉 ${task.first_step || task.title}\n\n5 分鐘後想停也可以；現在不用處理整件事。`,
      taskId: id,
      kind: "micro_start",
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("✅ 這步做完了", `系統：步驟完成:${id}`, "這一步做完了 ✅") },
          { type: "action", action: hiddenPostbackAction("😵 還是卡住", `系統：卡住任務:${id}`, "還是卡住了 😵") }
        ]
      }
    };
  }

  // first_step 有自己的進度：做完一步 ≠ 整件任務完成
  const stepDone = s.match(/^系統：步驟完成:(\d+)$/u);
  if (stepDone) {
    const id = Number(stepDone[1]);
    const task = await db.prepare(
      `UPDATE tasks SET stuck_count=0, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=? AND status IN ('pending','paused')
       RETURNING id,title`
    ).bind(id, uid).first();
    if (!task) return "這項好像已經處理掉了🐽";
    await logTaskEvent(db, id, uid, "step_done");
    return {
      text: `有開始就是前進了🐽✨\n「${task.title}」這一步完成。\n\n接下來想怎麼做？`,
      taskId: id,
      kind: "step_done",
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("✅ 整件做完了", `系統：完成任務:${id}`, `「${String(task.title).slice(0, 30)}」整件做完了 ✅`) },
          { type: "action", action: hiddenPostbackAction("▶️ 再做5分鐘", `系統：先做五分鐘:${id}`, "再做 5 分鐘 ▶️") },
          { type: "action", action: hiddenPostbackAction("🌙 先到這裡", `系統：先到這裡:${id}`, "今天先到這裡 🌙") }
        ]
      }
    };
  }

  const pause = s.match(/^系統：先到這裡:(\d+)$/u);
  if (pause) {
    await logTaskEvent(db, Number(pause[1]), uid, "paused_session");
    return "好🐽 今天有開始就算數，剩下的之後再說。";
  }

  const done = s.match(/^系統：完成任務:(\d+)$/u);
  if (done) {
    const result = await completeTask(db, uid, Number(done[1]));
    return result ? buildCompletionMessage(result, env) : "這項好像已經處理掉了🐽";
  }

  const del = s.match(/^系統：刪除任務:(\d+)$/u);
  if (del) {
    const id = Number(del[1]);
    const task = await db.prepare(
      "SELECT id,title FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";

    const saved = await setPendingPlan(db, uid, { action: "delete_tasks", task_ids: [id] });
    return withDeleteActions(`要移除「${task.title}」嗎？🐽\n移除後就不會再提醒囉。`, saved.id);
  }

  const snooze = s.match(/^系統：延後任務:(\d+):(\d+)$/u);
  if (snooze) {
    const id = Number(snooze[1]);
    const minutes = Number(snooze[2]);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 7 * 24 * 60) return "這個延後時間怪怪的🐽";

    const when = new Date(Date.now() + minutes * 60000).toISOString();
    const task = await db.prepare(
      `UPDATE tasks
       SET remind_at=?, reminder_sent_at=NULL, reminder_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=? AND status='pending'
       RETURNING id,title`
    ).bind(when, id, uid).first();
    if (task) await logTaskEvent(db, id, uid, "snoozed", String(minutes));

    return task
      ? `好呀🐽 我晚 ${minutes} 分鐘再叫你～`
      : "找不到這項待辦了🐽";
  }

  // 卡很多次時的出口：今天先放下，明早再輕輕提醒
  const tomorrow = s.match(/^系統：明天再說:(\d+)$/u);
  if (tomorrow) {
    const id = Number(tomorrow[1]);
    const task = await db.prepare(
      "SELECT id,title,recurrence_json FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    await logTaskEvent(db, id, uid, "deferred", "tomorrow");

    if (parseRecurrenceJson(task.recurrence_json)) {
      return `好，「${task.title}」這次先放過🐽 下次照平常的時間再提醒你。`;
    }

    const local = tpeLocal(Date.now());
    const nextDay = tpeLocal(Date.UTC(local.y, local.m - 1, local.d + 1, 12) - TPE_OFFSET_MS);
    const when = new Date(tpeToMs(nextDay.y, nextDay.m, nextDay.d, 9, 0)).toISOString();
    await db.prepare(
      "UPDATE tasks SET remind_at=?, reminder_sent_at=NULL, reminder_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=?"
    ).bind(when, id, uid).run();
    return `好，今天先放下「${task.title}」🐽\n明天早上 9 點我再輕輕提醒你一次。`;
  }

  return null;
}

/* ------------------------------------------------------------------------- *
 * 任務操作
 * ------------------------------------------------------------------------- */

/**
 * 完成任務。
 * - 一般任務：status=completed
 * - 例行任務：只記錄「這一次」完成，任務本身保持 pending，下次照常提醒。
 *   若今天的提醒還沒響，直接跳到下一次，避免做完了還被提醒。
 */
async function completeTask(db, uid, id) {
  const task = await db.prepare(
    "SELECT id,title,recurrence_json,remind_at,reminder_sent_at FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
  ).bind(id, uid).first();
  if (!task) return null;

  const recurrence = parseRecurrenceJson(task.recurrence_json);
  if (recurrence) {
    // 防止連點：10 分鐘內同一個例行任務只記一次完成
    const recent = await db.prepare(
      `SELECT id FROM task_events WHERE task_id=? AND line_user_id=? AND event_type='completed'
       AND created_at >= datetime('now','-10 minutes') LIMIT 1`
    ).bind(id, uid).first();
    if (recent) return { ...task, recurring: true, nextRemind: task.remind_at, duplicate: true };

    const now = Date.now();
    let nextRemind = task.remind_at;
    const t = task.remind_at ? new Date(task.remind_at).getTime() : NaN;
    if (Number.isFinite(t) && t > now && tpeDateKey(t) === tpeDateKey(now)) {
      nextRemind = computeNextOccurrence(task.remind_at, recurrence, now);
    }

    if (task.remind_at && !nextRemind) {
      // 例行任務已經到 until，這次就是最後一次
      await db.prepare(
        "UPDATE tasks SET status='completed', stuck_count=0, last_barrier=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=?"
      ).bind(id, uid).run();
      await logTaskEvent(db, id, uid, "completed", "final_occurrence");
      return { ...task, recurring: false };
    }

    await db.prepare(
      `UPDATE tasks SET stuck_count=0, last_barrier=NULL, remind_at=?,
         reminder_sent_at=CASE WHEN ? = remind_at THEN reminder_sent_at ELSE NULL END,
         reminder_claimed_at=CASE WHEN ? = remind_at THEN reminder_claimed_at ELSE NULL END,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=?`
    ).bind(nextRemind, nextRemind, nextRemind, id, uid).run();
    await logTaskEvent(db, id, uid, "completed", "occurrence");
    return { ...task, recurring: true, nextRemind };
  }

  const done = await db.prepare(
    "UPDATE tasks SET status='completed', stuck_count=0, last_barrier=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status IN ('pending','paused') RETURNING id,title"
  ).bind(id, uid).first();
  if (!done) return null;
  await logTaskEvent(db, id, uid, "completed");
  return { ...done, recurring: false };
}

async function markTaskStuck(db, uid, id, source = "button") {
  const task = await db.prepare(
    `UPDATE tasks
     SET stuck_count=COALESCE(stuck_count,0)+1, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND line_user_id=? AND status IN ('pending','paused')
     RETURNING id,title,first_step,due_time,task_type,stuck_count,last_barrier,recurrence_json`
  ).bind(id, uid).first();

  if (task) {
    await logTaskEvent(db, id, uid, "stuck", JSON.stringify({ count: Number(task.stuck_count || 1), source }));
  }
  return task;
}

function hoursUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? ms / 3600000 : null;
}

/** 例行任務的 due_time 只是下一次發生時間，不是截止日，所以不套用「截止前」策略。 */
function isNearDeadline(task) {
  if (parseRecurrenceJson(task.recurrence_json)) return false;
  const h = hoursUntil(task.due_time);
  return h !== null && h <= 24 && h > 0;
}

/**
 * 卡住介入狀態機：
 *   第 1 次：降低門檻（截止前 24 小時改成「能交出去的版本」）
 *   第 2 次以上：問卡點（tired / unclear / time / avoid）
 *   第 3 次以上：多一個「今天先放著」出口，避免無限迴圈
 */
function buildStuckIntervention(task) {
  const count = Number(task.stuck_count || 1);
  const first = String(task.first_step || task.title || "").trim();

  if (count <= 1) {
    const text = isNearDeadline(task)
      ? `先不追求完整，我們切成「能交出去」的版本🐽\n\n📌 ${task.title}\n👉 現在先做：${first}\n\n剩下的等這一步完成再決定。`
      : `不用處理整件事，先把門檻降到很低🐽\n\n📌 ${task.title}\n👉 只做這一步：${first}\n\n先做 5 分鐘就算有前進。`;
    return {
      text,
      taskId: task.id,
      kind: "stuck",
      quickReply: { items: [
        { type: "action", action: hiddenPostbackAction("▶️ 先做5分鐘", `系統：先做五分鐘:${task.id}`, "我先做 5 分鐘 ▶️") },
        { type: "action", action: hiddenPostbackAction("😵 還是很難", `系統：卡住任務:${task.id}`, "還是很難開始 😵") }
      ] }
    };
  }

  const items = [
    { type: "action", action: hiddenPostbackAction("😴 太累", `系統：障礙:${task.id}:tired`, "我現在太累 😴") },
    { type: "action", action: hiddenPostbackAction("❓ 不知怎開始", `系統：障礙:${task.id}:unclear`, "我不知道怎麼開始 ❓") },
    { type: "action", action: hiddenPostbackAction("⏰ 時間不夠", `系統：障礙:${task.id}:time`, "我時間不夠 ⏰") },
    { type: "action", action: hiddenPostbackAction("🙈 很不想做", `系統：障礙:${task.id}:avoid`, "我就是很不想做 🙈") }
  ];
  if (count >= 3) {
    items.push({ type: "action", action: hiddenPostbackAction("🌙 今天先放著", `系統：明天再說:${task.id}`, "今天先放著 🌙") });
  }

  return {
    text: `看起來不是提醒次數的問題，我們找真正卡點🐽\n「${task.title}」現在比較像哪一種？`,
    taskId: task.id,
    kind: "stuck",
    quickReply: { items }
  };
}

function buildBarrierPlan(task, kind) {
  const first = String(task.first_step || task.title || "").trim();
  const plans = {
    tired: `如果現在很累，就只做 5 分鐘「${first}」；5 分鐘到就可以停。`,
    unclear: `如果不知道怎麼開始，就先只做「${first}」，不要往後想。`,
    time: `如果今天時間真的不夠，就先做「${first}」，其餘先保留，不硬塞進今天。`,
    avoid: `可以很不想做，同時只做 5 分鐘「${first}」。不需要先讓自己有動力。`
  };
  const deadlineNote = isNearDeadline(task) ? "\n離截止不到一天，先做出「能交出去」的版本就好，不追求完整。" : "";
  return {
    text: `好，我們不跟卡住硬碰硬🐽\n\n${plans[kind] || plans.unclear}${deadlineNote}\n\n這次只要求「開始」，不要求一次做完。`,
    taskId: task.id,
    kind: "barrier",
    quickReply: { items: [
      { type: "action", action: hiddenPostbackAction("▶️ 好，先開始", `系統：先做五分鐘:${task.id}`, "好，我先開始 ▶️") },
      { type: "action", action: hiddenPostbackAction("📅 晚點再排", `系統：延後任務:${task.id}:60`, "一小時後再提醒我 📅") }
    ] }
  };
}

function buildCompletionMessage(result, env) {
  const base = String(env.PUBLIC_BASE_URL || "https://time-ai-assistant.410350515gin.workers.dev").replace(/\/$/, "");
  const index = Math.floor(Math.random() * REWARD_IMAGES_BASE64.length) + 1;

  if (result.duplicate) {
    return `「${result.title}」這次已經記過完成了🐽✨`;
  }

  const text = result.recurring
    ? `做完啦！🐽✨\n${result.title}\n這次記下來了${result.nextRemind ? `，下次 ${fmtTaipei(result.nextRemind)} 再提醒你` : ""}。`
    : `做完啦！🐽✨\n${result.title}\n這項我幫你收掉了。`;

  return {
    text,
    rewardImageUrl: REWARD_IMAGES_BASE64.length ? `${base}/reward-images/${index}.jpg` : undefined
  };
}

function buildWelcomeMessage() {
  return {
    text: [
      "嗨～我是豬豬行程小秘書🐽",
      "",
      "想到什麼直接跟我說，我可以幫你：",
      "📌 整理待辦和行程",
      "🔁 記住課表、健身等固定安排",
      "⏰ 到時間主動提醒",
      "🎯 把太複雜的任務拆簡單",
      "🧩 做不下去時，幫你換個比較好開始的方法",
      "✅ 記錄完成進度",
      "🌙 晚上回顧今天做了什麼、順便記錄心情",
      "",
      "不用先學指令，直接跟我說你想做什麼就好🐽",
      "小技巧：長按我的提醒、選「回覆」再打字，我就知道你在說哪一件事。"
    ].join("\n"),
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "📌 建立任務", text: "我想新增一個任務" } },
        { type: "action", action: hiddenPostbackAction("🐽 查看任務", "系統：列出任務", "查看所有任務") }
      ]
    }
  };
}

function hiddenPostbackAction(label, data, displayText = null) {
  const action = { type: "postback", label: String(label).slice(0, 20), data };
  if (displayText) action.displayText = String(displayText).slice(0, 300);
  return action;
}

function withDeleteActions(text, planId) {
  return {
    text,
    quickReply: {
      items: [
        { type: "action", action: hiddenPostbackAction("確定刪除🗑️", `系統：確認方案:${planId}`, "確定刪除 🗑️") },
        { type: "action", action: hiddenPostbackAction("先不要🙈", `系統：取消方案:${planId}`, "先不要🙈") }
      ]
    }
  };
}

function withPlanActions(text, planId, allowCategoryChange = false) {
  const items = [
    { type: "action", action: hiddenPostbackAction("好呀🐽", `系統：確認方案:${planId}`, "好呀🐽") }
  ];
  if (allowCategoryChange) {
    items.push({ type: "action", action: hiddenPostbackAction("🏷️ 改分類", "系統：改待確認分類", "修改分類 🏷️") });
  }
  items.push(
    { type: "action", action: hiddenPostbackAction("我要改✏️", `系統：修改方案:${planId}`, "我要改✏️") },
    { type: "action", action: hiddenPostbackAction("先不要🙈", `系統：取消方案:${planId}`, "先不要🙈") }
  );
  return { text, quickReply: { items } };
}

/* ------------------------------------------------------------------------- *
 * 自然語言（AI 理解 → 程式驗證 → 執行）
 * ------------------------------------------------------------------------- */

async function handleAiMessage(uid, text, env, meta = {}) {
  const db = env.DB;
  const pending = await getPendingPlan(db, uid);

  const quotedTask = meta.quotedMessageId ? await findQuotedTask(db, uid, meta.quotedMessageId) : null;
  const lastTask = await findLastTaskContext(db, uid);
  const active = await activeTasksContext(db, uid);
  const recent = await recentRemindersContext(db, uid);

  const hints = [];
  if (quotedTask) {
    hints.push(`使用者這則訊息「引用回覆」了一則關於任務 id=${quotedTask.id}「${quotedTask.title}」的訊息；他極可能就是在說這個任務。`);
  }
  if (lastTask && (!quotedTask || lastTask.id !== quotedTask.id)) {
    hints.push(`剛剛的對話正在談任務 id=${lastTask.id}「${lastTask.title}」（${lastTask.minutes_ago} 分鐘前）。短句若沒有指明別的任務，優先考慮它。`);
  }

  const pendingContext = pending?.plan_items?.length
    ? "尚未確認的方案：\n" + pending.plan_items.map((x, i) =>
        `proposal_${i + 1};title=${x.title || ""};start=${fmtCompact(x.start_time)};due=${fmtCompact(x.due_time)};remind=${fmtCompact(x.remind_at)};first_step=${x.first_step || ""}`
      ).join("\n")
    : "";

  const context = [
    hints.length ? "對話線索：\n" + hints.join("\n") : "",
    active.text ? "現有待辦：\n" + active.text : "現有待辦：目前沒有",
    recent.text,
    pendingContext
  ].filter(Boolean).join("\n\n");

  const started = Date.now();
  const result = await interpretStructured(text, context, env);

  // 引用回覆是決定性的線索：AI 判斷是完成/卡住但沒選出任務時，直接用被引用的任務。
  if (quotedTask && ["task_stuck", "complete_task"].includes(result.intent)) {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    if (!ids.length) result.task_ids = [quotedTask.id];
  }

  console.log("AI decision", {
    intent: result.intent,
    task_ids: normalizeTaskIds(result.task_ids, result.task_id),
    plan_items: Array.isArray(result.plan_items) ? result.plan_items.length : 0,
    candidates: {
      active: active.ids.length,
      recent_reminders: recent.ids,
      last_task: lastTask?.id || null,
      quoted_task: quotedTask?.id || null
    },
    fallback: Boolean(result._fallback),
    ai_ms: Date.now() - started,
    text_length: text.length
  });

  if (result.intent === "list_tasks") return buildTaskHubMessage();

  if (result.intent === "task_stuck") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    if (!ids.length) return result.reply || "我知道你現在還沒完成，但我不敢猜是哪一項🐽 可以長按那則提醒、選「回覆」再跟我說。";
    const task = await markTaskStuck(db, uid, ids[0], "ai_context");
    if (!task) return "找不到這項待辦了🐽";
    return buildStuckIntervention(task);
  }

  if (result.intent === "complete_task") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id).slice(0, 5);
    if (!ids.length) return result.reply || "我還不能確定你要完成哪一項任務。";

    const results = [];
    for (const id of ids) {
      const r = await completeTask(db, uid, id);
      if (r) results.push(r);
    }
    if (!results.length) return "找不到這個待辦任務。";
    if (results.length === 1) return buildCompletionMessage(results[0], env);
    const msg = buildCompletionMessage(results[0], env);
    return {
      ...msg,
      text: `做完啦！🐽✨\n${results.map(r => `✅ ${r.title}`).join("\n")}\n這些我都記下來了。`
    };
  }

  if (result.intent === "change_task_type") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    const type = ["routine", "goal", "daily"].includes(result.task_type) ? result.task_type : null;
    if (!ids.length || !type) return result.reply || "我還不能確定要改哪一項或改成哪一類🐽";

    const placeholders = ids.map(() => "?").join(",");
    const r = await db.prepare(
      `UPDATE tasks SET task_type=?, updated_at=CURRENT_TIMESTAMP
       WHERE line_user_id=? AND status IN ('pending','paused') AND id IN (${placeholders})`
    ).bind(type, uid, ...ids).run();

    return Number(r?.meta?.changes || 0) > 0
      ? `改好啦🐽 已移到 ${taskTypeLabel(type)} 任務。`
      : "找不到符合的待辦任務🐽";
  }

  if (result.intent === "delete_all_tasks") {
    const saved = await setPendingPlan(db, uid, { action: "delete_all" });
    return withDeleteActions("要把目前所有待辦任務都移除嗎？\n這會停止後續提醒，但會保留歷史紀錄。", saved.id);
  }

  if (result.intent === "delete_task") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    if (!ids.length) return result.reply || "我還不能確定你想刪除哪一項任務。";

    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT id,title FROM tasks
       WHERE line_user_id=? AND status IN ('pending','paused') AND id IN (${placeholders})`
    ).bind(uid, ...ids).all();
    const selected = rows.results || [];
    if (!selected.length) return "找不到你要刪除的待辦任務。";

    const saved = await setPendingPlan(db, uid, {
      action: "delete_tasks",
      task_ids: selected.map(t => Number(t.id))
    });

    const names = selected.map(t => `「${t.title}」`).join("、");
    return withDeleteActions(`要移除 ${names} 嗎？\n移除後會停止提醒，但會保留歷史紀錄。`, saved.id);
  }

  if (["propose_plan", "revise_plan", "create_reminder"].includes(result.intent)) {
    let items = sanitizePlanItems(result.plan_items);

    if (result.intent === "create_reminder" && items.length) {
      // 每個提醒用自己的相對時間；只有單一項目時才退回使用頂層 time_semantics（相容舊格式）。
      items = items.map(item => normalizeReminderItem(
        applyAiTimeSemantics(item, item.time_semantics || (items.length === 1 ? result.time_semantics : null))
      ));
    }

    // AI 理解語意；程式驗證時間、補例行任務的第一次提醒。
    items = items.map(validatePlanTimes).filter(Boolean).map(fillRecurringFirstReminder);

    if (result.intent === "create_reminder" && !items.some(x => x.remind_at)) {
      return result.reply || "我理解你要設定提醒，但目前還不能可靠確定提醒時間；請再補一點時間資訊。";
    }

    if (items.length) {
      const saved = await setPendingPlan(db, uid, { plan_items: items });
      if (result.intent === "create_reminder") {
        const lines = items.map(x => `📌 ${x.title}\n🏷️ ${taskTypeLabel(x.task_type)}\n⏰ 提醒：${x.remind_at ? fmtTaipei(x.remind_at) : "（沒有時間）"}${x.recurrence ? `\n🔁 ${formatRecurrence(x.recurrence)}` : ""}`);
        return withPlanActions(
          `好呀🐽 我先幫你排著～\n${lines.join("\n\n")}\n\n還沒正式存，選一下👇`,
          saved.id,
          items.length === 1
        );
      }

      const heading = "📅 我幫你整理好了🐽";
      return withPlanActions(`${result.reply || heading}\n\n${formatPlan(items)}\n\n選一下👇`, saved.id, items.length === 1);
    }
  }

  return result.reply || "我有收到，但目前還不能安全判斷你想執行哪個操作。";
}

async function findQuotedTask(db, uid, quotedMessageId) {
  try {
    return await db.prepare(
      `SELECT t.id, t.title FROM bot_messages b JOIN tasks t ON t.id=b.task_id
       WHERE b.message_id=? AND b.line_user_id=? AND t.status IN ('pending','paused')`
    ).bind(String(quotedMessageId), uid).first();
  } catch {
    return null;
  }
}

async function findLastTaskContext(db, uid) {
  return db.prepare(
    `SELECT t.id, t.title,
            CAST((julianday('now') - julianday(u.last_task_at)) * 1440 AS INTEGER) AS minutes_ago
     FROM users u JOIN tasks t ON t.id=u.last_task_id
     WHERE u.line_user_id=? AND t.status IN ('pending','paused')
       AND u.last_task_at >= datetime('now', ?)`
  ).bind(uid, `-${LAST_TASK_CONTEXT_MINUTES} minutes`).first();
}

async function recentRemindersContext(db, uid) {
  const r = await db.prepare(
    `SELECT t.id, t.title, MAX(e.created_at) AS sent_at
     FROM task_events e
     JOIN tasks t ON t.id=e.task_id
     WHERE e.line_user_id=?
       AND e.event_type='reminder_sent'
       AND e.created_at >= datetime('now','-6 hours')
       AND t.status IN ('pending','paused')
     GROUP BY t.id
     ORDER BY sent_at DESC
     LIMIT 5`
  ).bind(uid).all();

  const rows = r.results || [];
  if (!rows.length) return { text: "", ids: [] };
  return {
    ids: rows.map(x => Number(x.id)),
    text: "最近 6 小時提醒過的任務（新到舊；只是情境，不代表使用者一定在回覆它）：\n" +
      rows.map(x => `id=${x.id};title=${x.title};提醒於=${fmtCompact(sqlTsToIso(x.sent_at))}`).join("\n")
  };
}

async function activeTasksContext(db, uid) {
  const r = await db.prepare(
    `SELECT id,title,task_type,due_time,remind_at,stuck_count,recurrence_json
     FROM tasks WHERE line_user_id=? AND status IN ('pending','paused')
     ORDER BY COALESCE(remind_at, due_time, '9999-12-31'), priority ASC LIMIT 20`
  ).bind(uid).all();
  const rows = r.results || [];
  return {
    ids: rows.map(t => Number(t.id)),
    text: rows.map(t => {
      const bits = [`id=${t.id}`, `title=${t.title}`, `type=${t.task_type || "daily"}`];
      if (t.recurrence_json) bits.push("例行");
      if (t.due_time && !t.recurrence_json) bits.push(`due=${fmtCompact(t.due_time)}`);
      if (t.remind_at) bits.push(`remind=${fmtCompact(t.remind_at)}`);
      if (Number(t.stuck_count || 0) > 0) bits.push(`stuck=${Number(t.stuck_count)}`);
      return bits.join(";");
    }).join("\n")
  };
}

function normalizeTaskIds(taskIds, taskId) {
  const raw = Array.isArray(taskIds) && taskIds.length ? taskIds : (taskId !== null && taskId !== undefined ? [taskId] : []);
  return [...new Set(raw.map(Number).filter(Number.isInteger))].slice(0, 50);
}

function normalizeReminderItem(item) {
  if (!item) return item;

  let title = String(item.title || "").trim();
  title = title
    .replace(/^(提醒我|記得提醒我|到時候提醒我|叫我|通知我)\s*/u, "")
    .replace(/^去\s+/u, "去")
    .trim();

  return {
    ...item,
    title: title || String(item.title || "").trim(),
    description: item.description || null,
    first_step: title || String(item.first_step || item.title || "").trim(),
    // 提醒是一個時間點，不是一段工作時間。
    start_time: null,
    due_time: null,
    estimated_minutes: null
  };
}

function applyAiTimeSemantics(item, semantics) {
  if (!item || !semantics || typeof semantics !== "object") return item;
  if (semantics.kind !== "relative") return item;

  const amount = Number(semantics.amount);
  const unitMs = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[semantics.unit];
  if (!Number.isFinite(amount) || amount <= 0 || !unitMs) return item;

  const when = new Date(Date.now() + amount * unitMs).toISOString();
  return {
    ...item,
    start_time: when,
    due_time: when,
    remind_at: when,
    reason: "AI 負責理解相對時間語意；實際時間由程式精確計算。"
  };
}

function validatePlanTimes(item) {
  if (!item) return null;
  const now = Date.now();
  const out = { ...item };

  for (const key of ["start_time", "due_time", "remind_at"]) {
    if (!out[key]) continue;
    if (!Number.isFinite(new Date(out[key]).getTime())) out[key] = null;
  }

  // 提醒不可以默默排在過去。
  if (out.remind_at && new Date(out.remind_at).getTime() <= now) out.remind_at = null;

  if (out.start_time && out.due_time && new Date(out.due_time).getTime() < new Date(out.start_time).getTime()) {
    out.start_time = null;
  }
  return out;
}

/** 例行任務如果 AI 沒給第一次提醒時間，由程式依 recurrence 算出來（否則永遠不會提醒）。 */
function fillRecurringFirstReminder(item) {
  if (!item?.recurrence) return item;
  const recurrence = { ...item.recurrence };
  if (!recurrence.time) {
    recurrence.time = item.remind_at ? fmtLocalTime(item.remind_at) : "09:00";
  }
  const out = { ...item, recurrence, task_type: "routine" };
  if (!out.remind_at) {
    out.remind_at = computeNextOccurrence(new Date().toISOString(), recurrence, Date.now(), true);
  }
  // 例行任務的「截止」沒有意義，避免觸發截止前策略
  out.due_time = null;
  return out;
}

function sanitizePlanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(x => x && typeof x === "object" && x.title)
    .slice(0, 20)
    .map(x => {
      const recurrence = sanitizeRecurrence(x.recurrence);
      const type = String(x.task_type || "").toLowerCase();
      return {
        title: String(x.title).slice(0, 200),
        description: x.description ? String(x.description).slice(0, 1000) : null,
        first_step: String(x.first_step || x.title).slice(0, 500),
        priority: Number.isFinite(Number(x.priority)) ? Math.min(5, Math.max(1, Math.round(Number(x.priority)))) : 3,
        start_time: normalizeIso(x.start_time),
        due_time: normalizeIso(x.due_time),
        remind_at: normalizeIso(x.remind_at),
        estimated_minutes: x.estimated_minutes !== null && x.estimated_minutes !== undefined && x.estimated_minutes !== "" && Number.isFinite(Number(x.estimated_minutes))
          ? Math.max(1, Math.round(Number(x.estimated_minutes)))
          : null,
        recurrence,
        // 有 recurrence 一律是例行任務
        task_type: recurrence ? "routine" : (["routine", "goal", "daily"].includes(type) ? type : "daily"),
        time_semantics: sanitizeTimeSemantics(x.time_semantics),
        reason: x.reason ? String(x.reason).slice(0, 500) : ""
      };
    });
}

function sanitizeTimeSemantics(v) {
  if (!v || typeof v !== "object") return null;
  if (v.kind !== "relative") return null;
  const amount = Number(v.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!["minute", "hour", "day", "week"].includes(v.unit)) return null;
  return { kind: "relative", amount, unit: v.unit };
}

function sanitizeRecurrence(v) {
  if (!v || typeof v !== "object") return null;
  const freq = String(v.freq || "").toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(freq)) return null;

  const interval = Math.max(1, Math.min(365, Math.round(Number(v.interval)) || 1));
  const weekdays = Array.isArray(v.weekdays)
    ? [...new Set(v.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [];
  const dayOfMonth = v.day_of_month !== null && v.day_of_month !== undefined && Number.isInteger(Number(v.day_of_month))
    ? Math.max(1, Math.min(31, Number(v.day_of_month)))
    : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time || "")) ? String(v.time) : null;
  const until = normalizeIso(v.until);

  return { freq, interval, weekdays, day_of_month: dayOfMonth, time, until };
}

/**
 * AI 偶爾會輸出沒有時區的時間（例如 2026-10-24T15:00:00）。
 * Workers 執行環境是 UTC，直接 new Date() 會差 8 小時，所以一律視為台灣時間。
 */
function normalizeIso(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "+08:00";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function interpretStructured(message, context, env) {
  const now = Date.now();
  const local = tpeLocal(now);
  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
  const taipeiNow = `${local.y}-${pad2(local.m)}-${pad2(local.d)} ${pad2(local.hh)}:${pad2(local.mm)}（星期${weekdayNames[local.dow]}）`;

  const prompt = `你是繁體中文的「可愛豬豬小秘書 🐽」，負責理解使用者的話，輸出一個 JSON 讓程式執行。

說話人格（只影響 reply 欄位）：
- 可愛、親近、自然，回覆短而有行動感；可適度用 🐽✨📌⏰🙈，不要每句都塞。
- 不用「您好、為您安排」這種過度正式的說法；不講技術術語、資料庫、intent、模型。
- 不確定時誠實說，例如「這個時間我還不敢直接幫你定，想再確認一下🐽」。
- 不使用責備、羞辱、罪惡感或「應該更自律」式語氣。

現在台灣時間：${taipeiNow}，時區 Asia/Taipei。

${context}

規則：
1. 只輸出 JSON，不要 markdown。不要假裝資料已經儲存；你只能提出方案或判斷意圖。
2. intent 由你根據語意判斷，使用者不需要記固定指令。例：「都刪掉」「清空一下」→ delete_all_tasks；「把叫弟弟起床那個刪掉」→ delete_task；「這個做完了」→ complete_task；「列出任務」→ list_tasks。delete_all_tasks 不可建立一個叫「刪除全部任務」的新任務。
3. task_id / task_ids 只能從「現有待辦」「最近提醒過的任務」「對話線索」裡選真正存在的 id，不可捏造。無法唯一判斷時留空 []，並在 reply 請使用者指明。
4. 「對話線索」是最強的情境：使用者引用了某則訊息，或剛剛在談某個任務時，短句（「好了」「還沒」「做不下去」）優先對應那個任務。
5. 使用者在回應任務、語意是「尚未完成、做不下去、卡住、沒開始、目前做不到」，不論用什麼說法，intent=task_stuck。這要靠語意判斷，不要靠關鍵字；只有上下文足以指向某個待辦時才用 task_stuck，否則當一般聊天（chat）。
6. 「把 X 改成目標/日常/例行」→ intent=change_task_type，選出 task_ids，並填頂層 task_type。不要重新建立任務。
7. 使用者要求提醒 → intent=create_reminder。title 只寫行動本身（「去洗澡」，不要「提醒我去洗澡」）。提醒型的 start_time、due_time、estimated_minutes 一律 null。
8. 時間格式：所有時間都用台灣時間並且「必須」帶 +08:00，例如 2026-10-24T15:00:00+08:00；絕對不要用 Z 或省略時區。今天、明天、後天、週幾、下週、月底都以上面的現在台灣時間換算。
9. 相對時間（「兩分鐘後」「半小時後」「1.5 小時後」「三天後」）：不要自己算時間，改在「該項目自己的」plan_items[].time_semantics 填 {kind:"relative", amount, unit}，unit 只能 minute|hour|day|week（半小時 = 30 minute）；該項 remind_at 填 null。一句話有多個提醒時，每個項目各填自己的 time_semantics。
10. 絕對時間（「明早八點」「下週五下午三點」）：直接填 remind_at，time_semantics 填 {kind:"absolute"}。
11. 「下午」預設 13:00–17:59，只說下午不要排到晚上。「週五前」= 最晚本週五當天。使用者給了截止日，due_time 不得晚於它。
12. 使用者一次給多個任務時全部處理：找出依賴、優先順序、合理開始與截止時間；必要時比較衝突與負荷。除非使用者明確要求立即建立，否則用 propose_plan 提出方案讓他確認。資訊不足時保守，不要亂編固定行程。
13. 修改「尚未確認的方案」→ intent=revise_plan，輸出完整修正版 plan_items，不要另外新增無關任務。
14. 每個 plan_item 的 first_step 必須是 2–10 分鐘內能立刻開始、做完看得出來的動作，不可只是把原任務換句話說。大型、模糊或容易拖延的任務，第一步只要求開始。
15. 固定課表、每天/每週/每月 → 在 plan_items[].recurrence 填週期，不要展開成很多筆。格式：freq 只能 daily|weekly|monthly；interval 為整數；weekdays 用 0=週日…6=週六；time 用 HH:MM（台灣時間）；monthly 可填 day_of_month；until 為 ISO 或 null。例行任務可以不填 remind_at，程式會依 recurrence 算出第一次。
16. task_type：routine＝固定重複的課表/習慣（有 recurrence 必為 routine）；goal＝報告、考試、專案、申請等需要多步驟推進的目標；daily＝洗衣、拿包裹、回電話等一次性生活雜事。

JSON schema：
{
  "intent": "chat|propose_plan|revise_plan|create_reminder|list_tasks|complete_task|task_stuck|delete_task|delete_all_tasks|change_task_type",
  "reply": "給使用者看的繁體中文",
  "task_ids": [3],
  "task_type": "routine|goal|daily 或 null",
  "plan_items": [
    {
      "title": "任務名稱",
      "description": "補充或 null",
      "first_step": "最小可執行第一步",
      "priority": 1,
      "start_time": "ISO8601+08:00 或 null",
      "due_time": "ISO8601+08:00 或 null",
      "remind_at": "ISO8601+08:00 或 null",
      "time_semantics": { "kind": "relative|absolute|none", "amount": 30, "unit": "minute|hour|day|week" },
      "estimated_minutes": 30,
      "task_type": "routine|goal|daily",
      "recurrence": null,
      "reason": "排序或安排理由（簡短）"
    }
  ]
}

使用者：
${message}`;

  let raw;
  try {
    raw = await callGemini(prompt, env, { jsonMode: true, deadlineMs: GEMINI_TOTAL_DEADLINE_MS });
  } catch (err) {
    console.error("Structured Gemini call failed; using safe fallback", { message: String(err?.message || err).slice(0, 300) });
    return buildLocalFallback();
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    const m = String(raw).match(/\{[\s\S]*\}/);
    try {
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Gemini returned unparseable JSON; using safe fallback");
    return buildLocalFallback();
  }

  const allowed = new Set(["chat", "propose_plan", "revise_plan", "create_reminder", "list_tasks", "complete_task", "task_stuck", "delete_task", "delete_all_tasks", "change_task_type"]);
  if (!allowed.has(parsed.intent)) parsed.intent = "chat";
  if (typeof parsed.reply !== "string") parsed.reply = "";
  parsed.reply = parsed.reply.slice(0, 1500);
  if (!["routine", "goal", "daily"].includes(parsed.task_type)) parsed.task_type = null;
  parsed.task_ids = Array.isArray(parsed.task_ids) ? parsed.task_ids.map(Number).filter(Number.isInteger).slice(0, 50) : [];
  const n = Number(parsed.task_id);
  parsed.task_id = parsed.task_id !== null && parsed.task_id !== undefined && Number.isInteger(n) ? n : null;
  parsed.time_semantics = sanitizeTimeSemantics(parsed.time_semantics);
  if (!Array.isArray(parsed.plan_items)) parsed.plan_items = [];
  return parsed;
}

/** AI 不可用時：不猜、不提案，只誠實說明，並告訴使用者按鈕仍可用。 */
function buildLocalFallback() {
  return {
    intent: "chat",
    reply: "我這邊暫時沒辦法理解這句話，這次先不動你的任務🐽\n等一下再跟我說一次好嗎？按鈕操作（完成、卡住、查看任務）都還是可以正常用。",
    task_id: null,
    task_ids: [],
    plan_items: [],
    time_semantics: null,
    _fallback: true
  };
}

/**
 * Gemini 呼叫：依序嘗試設定的模型，有總時間上限。
 * - 429 / 503 / timeout：同模型重試一次後換下一個
 * - 400：可能是該模型不支援某個參數 → 換下一個模型
 * - 401 / 403：金鑰或權限問題 → 直接失敗
 */
async function callGemini(prompt, env, { jsonMode = true, deadlineMs = GEMINI_TOTAL_DEADLINE_MS } = {}) {
  const configured = String(env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
    .split(",").map(x => x.trim()).filter(Boolean);
  const models = [...new Set(configured)].slice(0, 3);
  const deadline = Date.now() + deadlineMs;
  const failures = [];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1500) break;
      try {
        const started = Date.now();
        const text = await executeGeminiFetch(model, prompt, env, jsonMode, Math.min(12000, remaining));
        console.log("Gemini call succeeded", { model, attempt, ms: Date.now() - started });
        return text.slice(0, 9000);
      } catch (err) {
        const status = Number(err?.status || 0) || null;
        failures.push({ model, attempt, status, name: err?.name || null });
        if (status === 401 || status === 403) throw err;

        const transient = status === 503 || status === 429 || status === 500 || err?.name === "AbortError";
        if (transient && attempt === 1 && deadline - Date.now() > 3000) {
          let delay = 400;
          if (status === 429 && err?.retryAfterMs) delay = Math.min(err.retryAfterMs, 2000);
          await sleep(delay);
          continue;
        }
        break; // 換下一個模型
      }
    }
  }

  const finalError = new Error("All Gemini models failed or deadline exceeded");
  finalError.failures = failures;
  console.error("Gemini exhausted", { failures });
  throw finalError;
}

async function executeGeminiFetch(model, prompt, env, jsonMode, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const base = String(env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

  try {
    const generationConfig = { temperature: 0.2, maxOutputTokens: jsonMode ? 1200 : 900 };
    if (jsonMode) generationConfig.responseMimeType = "application/json";

    // 選填：降低模型思考量以加快回應。值依模型而定，設錯會 400（會自動換下一個模型）。
    if (env.GEMINI_THINKING_LEVEL) {
      generationConfig.thinkingConfig = { thinkingLevel: String(env.GEMINI_THINKING_LEVEL) };
    } else if (env.GEMINI_THINKING_BUDGET !== undefined && env.GEMINI_THINKING_BUDGET !== "") {
      generationConfig.thinkingConfig = { thinkingBudget: Number(env.GEMINI_THINKING_BUDGET) };
    }

    const res = await fetch(
      `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
        signal: controller.signal
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      const err = new Error(`${model} -> ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      err.retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      console.error("Gemini HTTP error", { model, status: res.status, detail: detail.slice(0, 300) });
      throw err;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();
    if (!text) {
      const err = new Error(`${model} returned empty response`);
      err.status = 502;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripFence(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/* ------------------------------------------------------------------------- *
 * 台灣時間工具（固定 +08:00，台灣沒有日光節約時間）
 * ------------------------------------------------------------------------- */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 把 UTC 毫秒轉成台灣的年月日時分與星期（0=週日）。 */
function tpeLocal(ms) {
  const d = new Date(ms + TPE_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay()
  };
}

/** 台灣牆上時間 → UTC 毫秒。日期溢位（例如 2/31）會自動進位。 */
function tpeToMs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh, mm) - TPE_OFFSET_MS;
}

function tpeDateKey(ms) {
  const l = tpeLocal(ms);
  return `${l.y}-${pad2(l.m)}-${pad2(l.d)}`;
}

/** D1 的 CURRENT_TIMESTAMP 格式（YYYY-MM-DD HH:MM:SS，UTC）。比較字串時兩邊格式必須一致。 */
function toSqlTs(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function sqlTsToIso(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtTaipei(v) {
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) return String(v);
  const l = tpeLocal(ms);
  return `${pad2(l.m)}/${pad2(l.d)} ${pad2(l.hh)}:${pad2(l.mm)}`;
}

/** 給 AI 看的精簡時間（台灣時間），比 ISO 短也比較不會被誤讀。 */
function fmtCompact(v) {
  if (!v) return "";
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) return "";
  const l = tpeLocal(ms);
  return `${l.y}-${pad2(l.m)}-${pad2(l.d)} ${pad2(l.hh)}:${pad2(l.mm)}`;
}

function fmtLocalTime(v) {
  const l = tpeLocal(new Date(v).getTime());
  return `${pad2(l.hh)}:${pad2(l.mm)}`;
}

/* ------------------------------------------------------------------------- *
 * 例行任務：一筆任務 = 一個重複規則 + 下一次提醒時間（remind_at）
 * 每一次的完成/卡住記在 task_events。
 * ------------------------------------------------------------------------- */

function parseRecurrenceJson(v) {
  if (!v) return null;
  try { return sanitizeRecurrence(JSON.parse(v)); } catch { return null; }
}

/**
 * 算出下一次發生時間（ISO）。
 * @param currentIso    目前這一次（或錨點）的時間；週/日的 interval 以它所在的日/週為基準
 * @param nowMs         只回傳晚於現在的時間（錯過很多次時直接跳到未來，不會每分鐘補發）
 * @param includeAnchor true 時錨點當天本身也可以是答案（用來算「第一次」）
 */
function computeNextOccurrence(currentIso, r, nowMs = Date.now(), includeAnchor = false) {
  const cur = new Date(currentIso).getTime();
  if (!Number.isFinite(cur) || !r) return null;

  const c = tpeLocal(cur);
  const [hh, mm] = String(r.time || "09:00").split(":").map(Number);
  const interval = Math.max(1, Number(r.interval) || 1);
  const threshold = includeAnchor ? nowMs : Math.max(cur, nowMs);
  const anchorDay = Math.floor(Date.UTC(c.y, c.m - 1, c.d) / 86400000);
  let found = null;

  if (r.freq === "daily" || r.freq === "weekly") {
    const days = r.freq === "weekly" ? (r.weekdays?.length ? r.weekdays : [c.dow]) : null;
    const anchorWeekStart = anchorDay - c.dow; // 以週日為一週開始
    for (let k = includeAnchor ? 0 : 1; k <= 366 * 5; k++) {
      const dayNum = anchorDay + k;
      const day = new Date(dayNum * 86400000);
      if (r.freq === "daily") {
        if (k % interval !== 0) continue;
      } else {
        const weekIndex = Math.floor((dayNum - anchorWeekStart) / 7);
        if (weekIndex % interval !== 0 || !days.includes(day.getUTCDay())) continue;
      }
      const ms = tpeToMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
      if (ms > threshold) { found = ms; break; }
    }
  } else if (r.freq === "monthly") {
    const dom = r.day_of_month || c.d;
    for (let k = includeAnchor ? 0 : interval; k <= 12 * 50; k += interval) {
      const total = c.y * 12 + (c.m - 1) + k;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const ms = tpeToMs(y, m, Math.min(dom, lastDay), hh, mm);
      if (ms > threshold) { found = ms; break; }
    }
  }

  if (found === null) return null;
  if (r.until && found > new Date(r.until).getTime()) return null;
  return new Date(found).toISOString();
}

function formatRecurrence(r) {
  if (!r) return "";
  const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
  if (r.freq === "daily") return `每${r.interval > 1 ? r.interval : ""}天${r.time ? " " + r.time : ""}`;
  if (r.freq === "weekly") {
    const days = (r.weekdays || []).map(d => "週" + dayNames[d]).join("、");
    return `每${r.interval > 1 ? r.interval : ""}週${days ? " " + days : ""}${r.time ? " " + r.time : ""}`;
  }
  if (r.freq === "monthly") return `每${r.interval > 1 ? r.interval + "個" : ""}月${r.day_of_month ? " " + r.day_of_month + "號" : ""}${r.time ? " " + r.time : ""}`;
  return "";
}

/* ------------------------------------------------------------------------- *
 * Cron：到期提醒
 * 狀態：待送（claimed_at、sent_at 都是 NULL）→ 送出中（claimed_at）→ 已送（sent_at）
 * - 先 claim 再推播：兩個 cron 重疊時只有一個會送
 * - claim 超過 CLAIM_STALE_MINUTES 還沒送完（worker 中途被砍）可以重新 claim
 * - push 帶 retry key（task_id + 排定的 remind_at），重新 claim 後再送也不會變兩則
 * ------------------------------------------------------------------------- */

const CLAIM_STALE_MINUTES = 5;

async function processDueReminders(env, scheduledTime) {
  if (!env.DB || !env.CHANNEL_ACCESS_TOKEN) return;
  const db = env.DB;
  const stale = `-${CLAIM_STALE_MINUTES} minutes`;

  const nowIso = new Date(scheduledTime || Date.now()).toISOString();
  const due = await db.prepare(
    `SELECT id,line_user_id,title,due_time,remind_at,recurrence_json
     FROM tasks
     WHERE status='pending' AND remind_at IS NOT NULL AND remind_at <= ? AND reminder_sent_at IS NULL
       AND (reminder_claimed_at IS NULL OR reminder_claimed_at < datetime('now', ?))
     ORDER BY remind_at ASC
     LIMIT 50`
  ).bind(nowIso, stale).all();

  for (const task of (due.results || [])) {
    const claimed = await db.prepare(
      `UPDATE tasks SET reminder_claimed_at=CURRENT_TIMESTAMP
       WHERE id=? AND status='pending' AND reminder_sent_at IS NULL AND remind_at=?
         AND (reminder_claimed_at IS NULL OR reminder_claimed_at < datetime('now', ?))
       RETURNING id`
    ).bind(task.id, task.remind_at, stale).first();
    if (!claimed) continue; // 別的執行已經在處理

    const recurrence = parseRecurrenceJson(task.recurrence_json);
    const message = {
      text: [
        `📌 ${task.title}`,
        task.due_time && !recurrence ? `⏰ 截止：${fmtTaipei(task.due_time)}` : null,
        "",
        "做完就直接按下面 👇"
      ].filter(x => x !== null).join("\n"),
      taskId: Number(task.id),
      kind: "reminder",
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("完成了✅", `系統：完成任務:${task.id}`, `完成「${String(task.title || "").slice(0, 40)}」✅`) },
          { type: "action", action: hiddenPostbackAction("卡住了🧩", `系統：卡住任務:${task.id}`, `「${String(task.title || "").slice(0, 30)}」卡住了 🧩`) },
          { type: "action", action: hiddenPostbackAction("⏰ 30分鐘後", `系統：延後任務:${task.id}:30`, "30 分鐘後再提醒我 ⏰") }
        ]
      }
    };

    let sent;
    try {
      const retryKey = await deterministicUuid(`reminder:${task.id}:${task.remind_at}`);
      sent = await pushLine(env, task.line_user_id, message, { retryKey, purpose: "reminder" });
    } catch (err) {
      const status = Number(err?.status || 0);
      const permanent = status >= 400 && status < 500 && status !== 429; // 例如使用者封鎖 bot
      console.error("Reminder push failed", { task_id: task.id, status, permanent });
      await db.prepare(
        permanent
          ? "UPDATE tasks SET reminder_sent_at=CURRENT_TIMESTAMP, reminder_claimed_at=NULL WHERE id=? AND remind_at=?"
          : "UPDATE tasks SET reminder_claimed_at=NULL WHERE id=? AND remind_at=?"   // 放掉 claim，下一分鐘重試
      ).bind(task.id, task.remind_at).run();
      continue;
    }

    await recordSentMessages(db, task.line_user_id, message, sent);
    await logTaskEvent(db, Number(task.id), task.line_user_id, "reminder_sent", task.remind_at || null);

    const next = recurrence ? computeNextOccurrence(task.remind_at, recurrence, Date.now()) : null;
    if (next) {
      // 例行任務：排下一次，回到「待送」
      await db.prepare(
        "UPDATE tasks SET remind_at=?, reminder_sent_at=NULL, reminder_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND remind_at=?"
      ).bind(next, task.id, task.remind_at).run();
    } else {
      await db.prepare(
        "UPDATE tasks SET reminder_sent_at=CURRENT_TIMESTAMP, reminder_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND remind_at=?"
      ).bind(task.id, task.remind_at).run();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Cron：22:30 晚間回顧
 * ------------------------------------------------------------------------- */

async function processEveningCheckins(env, scheduledTime) {
  if (!env.DB || !env.CHANNEL_ACCESS_TOKEN) return;
  const db = env.DB;

  const nowMs = new Date(scheduledTime || Date.now()).getTime();
  const local = tpeLocal(nowMs);

  // 22:30–22:39 是重試窗口
  if (local.hh !== 22 || local.mm < 30 || local.mm > 39) return;

  const dateKey = tpeDateKey(nowMs);
  const dayStartMs = tpeToMs(local.y, local.m, local.d, 0, 0);
  const start = toSqlTs(dayStartMs);
  const end = toSqlTs(dayStartMs + 86400000);

  const users = await db.prepare(
    `SELECT line_user_id FROM users
     WHERE updated_at >= datetime('now','-30 day')
     ORDER BY updated_at DESC
     LIMIT 200`
  ).all();

  for (const row of (users.results || [])) {
    const uid = row.line_user_id;
    if (!uid) continue;

    // 先 claim 今天的回顧：已送過、或別的執行正在送（且還沒過期），就跳過。
    const claimed = await db.prepare(
      `INSERT INTO daily_checkins(line_user_id,date_key,claimed_at) VALUES (?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(line_user_id,date_key) DO UPDATE SET claimed_at=excluded.claimed_at
       WHERE daily_checkins.sent_at IS NULL
         AND (daily_checkins.claimed_at IS NULL OR daily_checkins.claimed_at < datetime('now', ?))
       RETURNING line_user_id`
    ).bind(uid, dateKey, `-${CLAIM_STALE_MINUTES} minutes`).first();
    if (!claimed) continue;

    // 用完成事件（而不是 tasks.updated_at）統計，例行任務每次完成也算得到。
    const completed = await db.prepare(
      `SELECT t.title FROM task_events e JOIN tasks t ON t.id=e.task_id
       WHERE e.line_user_id=? AND e.event_type='completed'
         AND e.created_at >= ? AND e.created_at < ?
       ORDER BY e.created_at ASC
       LIMIT 20`
    ).bind(uid, start, end).all();

    const titles = [...new Set((completed.results || []).map(x => String(x.title || "").trim()).filter(Boolean))];

    const summary = titles.length
      ? ["今天你完成了：", ...titles.slice(0, 5).map(x => `✅ ${x}`), titles.length > 5 ? `還有 ${titles.length - 5} 件 ✨` : null]
          .filter(Boolean).join("\n")
      : "今天沒有需要用完成數量證明什麼。能走到一天尾聲，就先讓自己收工一下🐽";

    const message = {
      text: `今天辛苦啦🐽\n\n${summary}\n\n今天整體感覺怎麼樣？`,
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("😄 很不錯", `系統：晚間心情:${dateKey}:great`, "😄 今天很不錯") },
          { type: "action", action: hiddenPostbackAction("🙂 還可以", `系統：晚間心情:${dateKey}:good`, "🙂 今天還可以") },
          { type: "action", action: hiddenPostbackAction("😐 普通", `系統：晚間心情:${dateKey}:neutral`, "😐 今天普通") },
          { type: "action", action: hiddenPostbackAction("😮‍💨 有點累", `系統：晚間心情:${dateKey}:tired`, "😮‍💨 今天有點累") },
          { type: "action", action: hiddenPostbackAction("😞 很低落", `系統：晚間心情:${dateKey}:low`, "😞 今天很低落") }
        ]
      }
    };

    try {
      const retryKey = await deterministicUuid(`evening:${uid}:${dateKey}`);
      await pushLine(env, uid, message, { retryKey, purpose: "evening" });
      await db.prepare(
        "UPDATE daily_checkins SET sent_at=CURRENT_TIMESTAMP, claimed_at=NULL WHERE line_user_id=? AND date_key=?"
      ).bind(uid, dateKey).run();
    } catch (err) {
      const status = Number(err?.status || 0);
      const permanent = status >= 400 && status < 500 && status !== 429;
      console.error("Evening check-in push failed", { date_key: dateKey, status, permanent });
      await db.prepare(
        permanent
          ? "UPDATE daily_checkins SET sent_at=CURRENT_TIMESTAMP, claimed_at=NULL WHERE line_user_id=? AND date_key=?"
          : "UPDATE daily_checkins SET claimed_at=NULL WHERE line_user_id=? AND date_key=?"   // 放掉 claim，下一分鐘重試
      ).bind(uid, dateKey).run();
    }
  }
}

/* ------------------------------------------------------------------------- *
 * D1 schema（每個 isolate 只跑一次；全部可重複執行）
 * 正式來源：cloudflare/schema.sql
 * ------------------------------------------------------------------------- */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'done',
    reply_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    line_user_id TEXT PRIMARY KEY,
    last_task_id INTEGER,
    last_task_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS pending_plans (
    line_user_id TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
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
    status TEXT NOT NULL DEFAULT 'pending',
    reminder_sent_at TEXT,
    reminder_claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    line_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_value TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS daily_checkins (
    line_user_id TEXT NOT NULL,
    date_key TEXT NOT NULL,
    mood TEXT,
    emotion_tag TEXT,
    claimed_at TEXT,
    sent_at TEXT,
    responded_at TEXT,
    PRIMARY KEY(line_user_id, date_key)
  )`,
  `CREATE TABLE IF NOT EXISTS bot_messages (
    message_id TEXT PRIMARY KEY,
    line_user_id TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    kind TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS push_usage (
    date_key TEXT NOT NULL,
    purpose TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(date_key, purpose)
  )`
];

// 舊資料庫補欄位（欄位已存在時 SQLite 會報 duplicate column，忽略即可）
const SCHEMA_ALTERS = [
  "ALTER TABLE tasks ADD COLUMN reminder_sent_at TEXT",
  "ALTER TABLE tasks ADD COLUMN recurrence_json TEXT",
  "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'daily'",
  "ALTER TABLE tasks ADD COLUMN stuck_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN last_barrier TEXT",
  "ALTER TABLE tasks ADD COLUMN reminder_claimed_at TEXT",
  "ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done'",
  "ALTER TABLE webhook_events ADD COLUMN reply_json TEXT",
  "ALTER TABLE webhook_events ADD COLUMN updated_at TEXT",
  "ALTER TABLE users ADD COLUMN last_task_id INTEGER",
  "ALTER TABLE users ADD COLUMN last_task_at TEXT",
  "ALTER TABLE daily_checkins ADD COLUMN claimed_at TEXT"
];

const SCHEMA_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(line_user_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_time)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at)",
  "CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_task_events_user_type ON task_events(line_user_id, event_type, created_at)",
  // 舊版例行任務資料修正（只影響尚未修正的列）
  "UPDATE tasks SET task_type='routine' WHERE recurrence_json IS NOT NULL AND recurrence_json <> '' AND task_type <> 'routine'"
];

let schemaReadyPromise = null;

/** 每個 isolate 第一次用到 DB 時跑一次 schema 檢查，之後的訊息完全不付這個成本。 */
function ensureSchemaOnce(db) {
  if (!db) return Promise.resolve();
  if (!schemaReadyPromise) {
    schemaReadyPromise = runSchema(db).catch(err => {
      schemaReadyPromise = null; // 失敗就讓下一次重試
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function runSchema(db) {
  for (const sql of SCHEMA_STATEMENTS) await db.prepare(sql).run();
  for (const sql of SCHEMA_ALTERS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
    }
  }
  for (const sql of SCHEMA_INDEXES) await db.prepare(sql).run();
}

/* ------------------------------------------------------------------------- *
 * DB helpers
 * ------------------------------------------------------------------------- */

async function ensureUser(db, uid) {
  await db.prepare(
    `INSERT INTO users(line_user_id,updated_at)
     VALUES (?,CURRENT_TIMESTAMP)
     ON CONFLICT(line_user_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`
  ).bind(uid).run();
}

/** 只回傳 PENDING_PLAN_TTL_MINUTES 內的待確認方案；過期的方案一句「好」也不能觸發。 */
async function getPendingPlan(db, uid) {
  const row = await db.prepare(
    "SELECT plan_json FROM pending_plans WHERE line_user_id=? AND updated_at >= datetime('now', ?)"
  ).bind(uid, `-${PENDING_PLAN_TTL_MINUTES} minutes`).first();
  if (!row?.plan_json) return null;
  try {
    const plan = JSON.parse(row.plan_json);
    if (plan && !plan.id) plan.id = "legacy";
    return plan;
  } catch {
    return null;
  }
}

/** 存待確認方案；每份方案有自己的 id，按鈕只能確認那一份。 */
async function setPendingPlan(db, uid, data) {
  const plan = { ...data, id: data.id || crypto.randomUUID().replace(/-/g, "").slice(0, 12) };
  await db.prepare(
    "INSERT INTO pending_plans(line_user_id,plan_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(line_user_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=CURRENT_TIMESTAMP"
  ).bind(uid, JSON.stringify(plan)).run();
  return plan;
}

async function clearPendingPlan(db, uid) {
  await db.prepare("DELETE FROM pending_plans WHERE line_user_id=?").bind(uid).run();
}

async function savePlanTasks(db, uid, items) {
  if (!items.length) return 0;
  const stmts = items.map(x => db.prepare(
    `INSERT INTO tasks(
      line_user_id,title,description,first_step,priority,start_time,due_time,remind_at,estimated_minutes,recurrence_json,task_type,status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`
  ).bind(
    uid, x.title, x.description, x.first_step, x.priority,
    x.start_time, x.due_time, x.remind_at, x.estimated_minutes,
    x.recurrence ? JSON.stringify(x.recurrence) : null,
    x.recurrence ? "routine" : x.task_type
  ));
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + Number(r?.meta?.changes || 0), 0);
}

async function logTaskEvent(db, taskId, uid, type, value = null) {
  try {
    await db.prepare("INSERT INTO task_events(task_id,line_user_id,event_type,event_value) VALUES (?,?,?,?)")
      .bind(taskId, uid, type, value).run();
  } catch (err) {
    console.warn("Task event log failed", { task_id: taskId, type, message: String(err?.message || err) });
  }
}

/* ------------------------------------------------------------------------- *
 * 任務中心 UI
 * ------------------------------------------------------------------------- */

function taskTypeLabel(type) {
  return { routine: "🔁 例行", goal: "🎯 目標", daily: "🧺 日常" }[type] || "🧺 日常";
}

function formatPlan(items) {
  return items.map((x, i) => {
    const bits = [
      `${i + 1}. ${x.title}`,
      `分類 ${taskTypeLabel(x.task_type)}`,
      x.start_time ? `開始 ${fmtTaipei(x.start_time)}` : null,
      x.due_time ? `截止 ${fmtTaipei(x.due_time)}` : null,
      x.remind_at ? `提醒 ${fmtTaipei(x.remind_at)}` : null,
      x.recurrence ? `重複 ${formatRecurrence(x.recurrence)}` : null,
      x.estimated_minutes ? `${x.estimated_minutes} 分鐘` : null
    ].filter(Boolean);
    return bits.join("｜") + (x.reason ? `\n   原因：${x.reason}` : "");
  }).join("\n");
}
function categoryChoiceMessage(title, target) {
  const pending = target === "pending";
  const prefix = pending ? "系統：設定待確認分類:" : `系統：設定分類:${target}:`;
  return {
    text: `「${title}」要放去哪一類？🐽`,
    quickReply: {
      items: [
        { type: "action", action: hiddenPostbackAction("🔁 例行", prefix + "routine", "改成例行任務 🔁") },
        { type: "action", action: hiddenPostbackAction("🎯 目標", prefix + "goal", "改成目標任務 🎯") },
        { type: "action", action: hiddenPostbackAction("🧺 日常", prefix + "daily", "改成日常任務 🧺") }
      ]
    }
  };
}

function buildTaskHubMessage() {
  return {
    text: "任務中心來啦🐽✨\n想看哪一區？",
    flex: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🐽 任務中心", weight: "bold", size: "xl" },
          { type: "text", text: "我幫你分成三區，找起來比較快～", wrap: true, size: "sm" },
          {
            type: "button",
            action: hiddenPostbackAction("🔁 例行性任務", "系統：任務分類:routine", "查看例行性任務 🔁")
          },
          {
            type: "button",
            action: hiddenPostbackAction("🎯 目標任務", "系統：任務分類:goal", "查看目標任務 🎯")
          },
          {
            type: "button",
            action: hiddenPostbackAction("🧺 日常任務", "系統：任務分類:daily", "查看日常任務 🧺")
          }
        ]
      }
    }
  };
}

async function listTasksByType(db, uid, type) {
  const meta = {
    routine: { title: "🔁 例行性任務", empty: "目前沒有固定例行任務喔🐽" },
    goal: { title: "🎯 目標任務", empty: "目前沒有目標任務喔🐽" },
    daily: { title: "🧺 日常任務", empty: "目前沒有日常任務喔🐽" }
  }[type];

  const r = await db.prepare(
    "SELECT id,title,due_time,remind_at,recurrence_json FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') AND task_type=? ORDER BY COALESCE(due_time,remind_at,'9999-12-31'), priority ASC LIMIT 12"
  ).bind(uid, type).all();

  const rows = r.results || [];
  if (!rows.length) {
    return {
      text: meta.empty,
      quickReply: {
        items: [{
          type: "action",
          action: hiddenPostbackAction("← 回任務中心", "系統：列出任務", "查看所有任務")
        }]
      }
    };
  }

  const contents = [
    { type: "text", text: meta.title, weight: "bold", size: "xl" },
    { type: "separator", margin: "md" }
  ];

  for (const t of rows.slice(0, 6)) {
    const when = t.remind_at || t.due_time;
    const recur = parseRecurrenceJson(t.recurrence_json);
    const detail = recur
      ? formatRecurrence(recur)
      : (when ? fmtTaipei(when) : "尚未排時間");

    contents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        { type: "text", text: String(t.title || "").slice(0, 40), weight: "bold", wrap: true },
        { type: "text", text: detail, size: "sm", color: "#777777", wrap: true },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("✅ 完成", `系統：完成任務:${t.id}`, `完成「${String(t.title || "").slice(0, 40)}」✅`)
            },
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🧩 卡住", `系統：卡住任務:${t.id}`, `「${String(t.title || "").slice(0, 30)}」卡住了 🧩`)
            }
          ]
        },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🏷 分類", `系統：改分類:${t.id}`, `修改「${String(t.title || "").slice(0, 40)}」分類 🏷️`)
            },
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🗑 刪除", `系統：刪除任務:${t.id}`, `刪除「${String(t.title || "").slice(0, 40)}」🗑️`)
            }
          ]
        }
      ]
    });
  }

  return {
    text: meta.title,
    flex: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents }
    },
    quickReply: {
      items: [{
        type: "action",
        action: hiddenPostbackAction("← 回任務中心", "系統：列出任務", "查看所有任務")
      }]
    }
  };
}

/* ------------------------------------------------------------------------- *
 * Rich Menu（點了送 postback「系統：列出任務」，與 Fast Path 統一）
 * ------------------------------------------------------------------------- */

let richMenuReadyInIsolate = false;

async function ensurePigRichMenu(env, { force = false } = {}) {
  if (richMenuReadyInIsolate && !force) return null;

  await ensureSchemaOnce(env.DB);
  if (!force) {
    const saved = await env.DB.prepare("SELECT value FROM app_settings WHERE key=?").bind(RICH_MENU_SETTING_KEY).first();
    if (saved?.value) {
      richMenuReadyInIsolate = true;
      return saved.value;
    }
  }

  const auth = { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` };
  const api = lineApiBase(env);

  // 之前建立到一半的同名選單就沿用
  const listRes = await fetch(`${api}/v2/bot/richmenu/list`, { headers: auth });
  if (!listRes.ok) {
    const detail = await listRes.text();
    throw new Error(`LINE rich menu list ${listRes.status}: ${detail.slice(0, 200)}`);
  }
  const list = await listRes.json();
  let richMenuId = (list.richmenus || []).find(x => x.name === RICH_MENU_NAME)?.richMenuId || null;

  if (!richMenuId) {
    const createRes = await fetch(`${api}/v2/bot/richmenu`, {
      method: "POST",
      headers: { ...auth, ...JSON_HEADERS },
      body: JSON.stringify({
        size: { width: 2500, height: 843 },
        selected: true,
        name: RICH_MENU_NAME,
        chatBarText: "🐽 任務本",
        areas: [{
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: { type: "postback", label: "查看所有任務", data: "系統：列出任務", displayText: "查看所有任務" }
        }]
      })
    });
    if (!createRes.ok) {
      const detail = await createRes.text();
      throw new Error(`LINE rich menu create ${createRes.status}: ${detail.slice(0, 300)}`);
    }
    richMenuId = (await createRes.json()).richMenuId;

    const png = await buildPigRichMenuPng();
    const uploadRes = await fetch(`${lineDataApiBase(env)}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, {
      method: "POST",
      headers: { ...auth, "content-type": "image/png" },
      body: png
    });
    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      throw new Error(`LINE rich menu image upload ${uploadRes.status}: ${detail.slice(0, 300)}`);
    }
  }

  const defaultRes = await fetch(`${api}/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`, {
    method: "POST",
    headers: auth
  });
  if (!defaultRes.ok) {
    const detail = await defaultRes.text();
    throw new Error(`LINE default rich menu ${defaultRes.status}: ${detail.slice(0, 300)}`);
  }

  await env.DB.prepare(
    "INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
  ).bind(RICH_MENU_SETTING_KEY, richMenuId).run();

  richMenuReadyInIsolate = true;
  console.log("Pig task Rich Menu ready", { richMenuId });
  return richMenuId;
}

/* ------------------------------------------------------------------------- *
 * 診斷（需要 ADMIN_TOKEN）
 * ------------------------------------------------------------------------- */

async function runReminderDiagnostics(env) {
  const result = {
    now: new Date().toISOString(),
    timezone: "Asia/Taipei",
    db_bound: Boolean(env.DB),
    pending_with_reminder: 0,
    due_now: 0,
    sending_now: 0,
    next_reminder_at: null
  };
  if (!env.DB) return json(result, 503);
  await ensureSchemaOnce(env.DB);
  const now = new Date().toISOString();

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE status='pending' AND remind_at IS NOT NULL AND reminder_sent_at IS NULL"
  ).first();
  const due = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE status='pending' AND remind_at IS NOT NULL AND remind_at <= ? AND reminder_sent_at IS NULL"
  ).bind(now).first();
  const sending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE reminder_claimed_at IS NOT NULL AND reminder_sent_at IS NULL"
  ).first();
  const next = await env.DB.prepare(
    "SELECT MIN(remind_at) AS t FROM tasks WHERE status='pending' AND remind_at IS NOT NULL AND reminder_sent_at IS NULL"
  ).first();

  // 只回統計，不回任務標題或使用者 id
  result.pending_with_reminder = Number(pending?.n || 0);
  result.due_now = Number(due?.n || 0);
  result.sending_now = Number(sending?.n || 0);
  result.next_reminder_at = next?.t || null;
  return json(result);
}

async function runDiagnostics(env) {
  const result = {
    runtime: "cloudflare-workers",
    version: "0.3",
    db_bound: Boolean(env.DB),
    secrets: {
      GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
      CHANNEL_SECRET: Boolean(env.CHANNEL_SECRET),
      CHANNEL_ACCESS_TOKEN: Boolean(env.CHANNEL_ACCESS_TOKEN),
      ADMIN_TOKEN: Boolean(env.ADMIN_TOKEN)
    },
    gemini: { ok: false, model: null, status: null },
    line: { ok: false, status: null },
    db: { ok: false, status: env.DB ? "bound" : "not_bound" },
    push_usage: { this_month_total: 0, by_purpose: {}, last_7_days: [] }
  };

  if (env.DB) {
    try {
      await ensureSchemaOnce(env.DB);
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      result.db.ok = row?.ok === 1;
      result.db.status = result.db.ok ? "ok" : "query_failed";

      const monthPrefix = tpeDateKey(Date.now()).slice(0, 7);
      const usage = await env.DB.prepare(
        "SELECT purpose, SUM(count) AS n FROM push_usage WHERE date_key LIKE ? GROUP BY purpose"
      ).bind(`${monthPrefix}%`).all();
      for (const u of usage.results || []) {
        result.push_usage.by_purpose[u.purpose] = Number(u.n || 0);
        result.push_usage.this_month_total += Number(u.n || 0);
      }
      const daily = await env.DB.prepare(
        "SELECT date_key, SUM(count) AS n FROM push_usage GROUP BY date_key ORDER BY date_key DESC LIMIT 7"
      ).all();
      result.push_usage.last_7_days = (daily.results || []).map(d => ({ date: d.date_key, pushes: Number(d.n || 0) }));
    } catch (err) {
      result.db.status = String(err?.message || err);
    }
  }

  try {
    const started = Date.now();
    const text = await callGemini("Reply with exactly OK", env, { jsonMode: false, deadlineMs: 8000 });
    result.gemini = { ok: Boolean(text), status: 200, ms: Date.now() - started };
  } catch (err) {
    result.gemini = { ok: false, status: String(err?.message || err).slice(0, 200), failures: err?.failures || null };
  }

  try {
    const res = await fetch(`${lineApiBase(env)}/v2/bot/info`, {
      headers: { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN || ""}` }
    });
    result.line.status = res.status;
    result.line.ok = res.ok;
  } catch (err) {
    result.line.status = String(err?.name || err);
  }

  return json(result);
}

async function buildPigRichMenuPng() {
  const width = 2500;
  const height = 843;
  const stride = 1 + width * 3;
  const raw = new Uint8Array(stride * height);

  // Soft pink background.
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = 255;
      raw[p + 1] = 241;
      raw[p + 2] = 244;
    }
  }

  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const p = y * stride + 1 + x * 3;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
  };

  const circle = (cx, cy, radius, color) => {
    const [r,g,b] = color;
    const r2 = radius * radius;
    for (let y = Math.max(0, cy-radius); y <= Math.min(height-1, cy+radius); y++) {
      const dy = y - cy;
      const dx = Math.floor(Math.sqrt(Math.max(0, r2 - dy*dy)));
      for (let x = cx-dx; x <= cx+dx; x++) setPixel(x,y,r,g,b);
    }
  };

  // Pig face.
  circle(500, 420, 235, [255,186,200]);
  circle(405, 365, 24, [65,50,55]);
  circle(595, 365, 24, [65,50,55]);
  circle(500, 500, 115, [255,218,225]);
  circle(455, 500, 18, [90,65,72]);
  circle(545, 500, 18, [90,65,72]);

  // Cute ear triangles.
  for (let yy = 165; yy < 310; yy++) {
    const span = Math.floor((yy - 165) * 0.9);
    for (let xx = 275 - span/2; xx <= 275 + span/2; xx++) setPixel(Math.floor(xx),yy,255,186,200);
    for (let xx = 725 - span/2; xx <= 725 + span/2; xx++) setPixel(Math.floor(xx),yy,255,186,200);
  }

  // Simple bitmap word TASKS; whole banner is one tappable button.
  const glyphs = {
    T:["11111","00100","00100","00100","00100","00100","00100"],
    A:["01110","10001","10001","11111","10001","10001","10001"],
    S:["01111","10000","10000","01110","00001","00001","11110"],
    K:["10001","10010","10100","11000","10100","10010","10001"]
  };
  const word = "TASKS";
  const scale = 34;
  const gap = 44;
  let x0 = 1050;
  const y0 = 265;

  for (const ch of word) {
    const rows = glyphs[ch];
    for (let gy=0; gy<7; gy++) {
      for (let gx=0; gx<5; gx++) {
        if (rows[gy][gx] !== "1") continue;
        for (let py=0; py<scale; py++) {
          for (let px=0; px<scale; px++) {
            setPixel(x0 + gx*scale + px, y0 + gy*scale + py, 65,50,55);
          }
        }
      }
    }
    x0 += 5*scale + gap;
  }

  const compressed = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))
  ).arrayBuffer());

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n=0; n<256; n++) {
      let cc=n;
      for (let k=0; k<8; k++) cc = (cc & 1) ? (0xedb88320 ^ (cc >>> 1)) : (cc >>> 1);
      table[n]=cc>>>0;
    }
    return table;
  })();

  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const u32 = n => new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
  const chunk = (type, data) => {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes,0); crcInput.set(data,typeBytes.length);
    const out = new Uint8Array(12 + data.length);
    out.set(u32(data.length),0);
    out.set(typeBytes,4);
    out.set(data,8);
    out.set(u32(crc32(crcInput)),8+data.length);
    return out;
  };

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width),0);
  ihdr.set(u32(height),4);
  ihdr[8]=8;   // bit depth
  ihdr[9]=2;   // RGB
  ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;

  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const chunks = [chunk("IHDR",ihdr), chunk("IDAT",compressed), chunk("IEND",new Uint8Array())];
  const size = signature.length + chunks.reduce((n,x)=>n+x.length,0);
  const png = new Uint8Array(size);
  let offset=0;
  png.set(signature,offset); offset+=signature.length;
  for (const part of chunks) { png.set(part,offset); offset+=part.length; }
  return png;
}

async function verifyLineSignature(body, signature, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const expected = btoa(binary);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
