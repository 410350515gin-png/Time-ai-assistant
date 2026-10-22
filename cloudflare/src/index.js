import { REWARD_IMAGES_BASE64 } from "./rewardImages.js";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const YES = new Set(["是","好","確認","確認執行","同意","可以","ok","yes","好啊","照這個安排","確認計畫","好呀🐽"]);
const NO = new Set(["否","不要","取消","不用","no","先不要","不接受","先不要🙈"]);
const MODIFY = new Set(["修改","我要改","我要修改","調整","我要改✏️"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        status: "ok",
        runtime: "cloudflare-workers",
        version: "0.2",
        db_bound: Boolean(env.DB)
      });
    }

    if (request.method === "GET" && url.pathname === "/diag") {
      return runDiagnostics(env);
    }

    if (request.method === "GET" && url.pathname === "/diag/reminders") {
      return runReminderDiagnostics(env);
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
    console.log("Cron scheduled event", {
      scheduledTime: controller.scheduledTime,
      cron: controller.cron || null
    });
    ctx.waitUntil(processDueReminders(env, controller.scheduledTime));
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

        await processQueuedLineEvent(body.event, env);
        message.ack();
      } catch (err) {
        console.error("Queue processing failed", {
          name: err?.name || null,
          message: err?.message || String(err),
          stack: err?.stack || null
        });
        message.retry({ delaySeconds: 30 });
      }
    }
  }
};

async function handleLineWebhook(request, env, ctx) {
  console.log("LINE webhook received", request.method, new URL(request.url).pathname);
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
  console.log("LINE events count", events.length);

  if (!env.GEMINI_QUEUE) {
    console.error("GEMINI_QUEUE binding missing");
    return json({ error: "queue unavailable" }, 503);
  }

  try {
    for (const event of events) {
      await env.GEMINI_QUEUE.send({
        type: "LINE_EVENT",
        event,
        enqueued_at: Date.now()
      });
    }
  } catch (err) {
    console.error("Queue enqueue failed", {
      name: err?.name || null,
      message: err?.message || String(err)
    });
    return json({ error: "queue enqueue failed" }, 503);
  }

  return json({ status: "queued", count: events.length });
}

async function processQueuedLineEvent(event, env) {
  if (event?.type !== "message" || event?.message?.type !== "text") return;

  const text = (event.message.text || "").trim();
  const uid = event?.source?.userId;
  if (!text || !uid) return;

  if (env.DB) {
    await ensureSchema(env.DB);
    await ensureReminderColumn(env.DB);
  }

  console.log("Queue LINE text event", {
    textLength: text.length,
    db: Boolean(env.DB),
    webhookEventId: event.webhookEventId || null
  });

  if (env.DB && event.webhookEventId) {
    const inserted = await rememberEvent(env.DB, event.webhookEventId);
    if (!inserted) {
      console.log("Duplicate queued webhook skipped", event.webhookEventId);
      return;
    }
  }

  let reply;
  try {
    reply = env.DB
      ? await handleTaskMessage(uid, text, env)
      : await interpretPlainText(text, env);
    console.log("Queue AI/task reply ready", { length: messageText(reply).length, quickReply: Boolean(reply?.quickReply) });
  } catch (err) {
    console.error("Queued message processing failed", {
      name: err?.name || null,
      message: err?.message || String(err),
      stack: err?.stack || null
    });
    throw err;
  }

  await pushLine(uid, reply, env.CHANNEL_ACCESS_TOKEN);
  console.log("LINE push sent from queue");
}

async function processLineEvents(events, env) {
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
    } catch (err) {
      console.error("D1 schema init failed", err);
    }
  }

  for (const event of events) {
    if (event?.type !== "message" || event?.message?.type !== "text") continue;

    const text = (event.message.text || "").trim();
    const replyToken = event.replyToken;
    const uid = event?.source?.userId;
    if (!text || !replyToken || !uid) continue;

    console.log("LINE text event", { hasReplyToken: true, textLength: text.length, db: Boolean(env.DB) });

    if (env.DB && event.webhookEventId) {
      const inserted = await rememberEvent(env.DB, event.webhookEventId);
      if (!inserted) {
        console.log("Duplicate webhook skipped", event.webhookEventId);
        continue;
      }
    }

    let reply;
    try {
      reply = env.DB
        ? await handleTaskMessage(uid, text, env)
        : await interpretPlainText(text, env);
      console.log("AI/task reply ready", { length: reply.length });
    } catch (err) {
      console.error("Message processing failed", {
        name: err?.name || null,
        message: err?.message || String(err),
        stack: err?.stack || null
      });
      reply = "這次處理失敗，但 LINE 連線正常。請稍後再傳一次。";
    }

    try {
      await replyLine(replyToken, reply, env.CHANNEL_ACCESS_TOKEN);
      console.log("LINE reply sent successfully");
    } catch (err) {
      console.error("LINE reply failed", err);
    }
  }
}

async function handleTaskMessage(uid, text, env) {
  await ensureUser(env.DB, uid);
  const lower = text.toLowerCase();

  const pending = await getPendingPlan(env.DB, uid);
  if (pending && YES.has(lower)) {
    const items = Array.isArray(pending.plan_items) ? pending.plan_items : [];
    const saved = await savePlanTasks(env.DB, uid, items);
    await clearPendingPlan(env.DB, uid);
    return `✅ 好呀🐽 已經幫你存好 ${saved} 項任務。\n之後可以直接跟我說「列出任務」或告訴我哪一項完成了。`;
  }

  if (pending && NO.has(lower)) {
    await clearPendingPlan(env.DB, uid);
    return "好～這次先不存🙈";
  }

  if (pending && MODIFY.has(lower)) {
    return "可以呀✏️ 直接告訴我你想改哪裡，例如「第一項改到晚上 8 點」或「第二項延到明天」。";
  }

  if (/^(列出|查看|顯示).*(任務|待辦)|^(任務|待辦)(清單)?$/u.test(text)) {
    return listTasksText(env.DB, uid);
  }

  const smartReminder = await resolveReminderIntent(text, env);
  if (smartReminder) {
    await setPendingPlan(env.DB, uid, { plan_items: [smartReminder] });
    return withPlanActions(`⏰ 好，我先幫你設好：${smartReminder.title}\n提醒時間：${fmtTaipei(smartReminder.remind_at)}\n\n目前還沒存，選一下👇`);
  }


  if (/^(完成|完成了|做完|做完了|好了|搞定)$/u.test(text)) {
    const recent = await env.DB.prepare(
      `SELECT id,title
       FROM tasks
       WHERE line_user_id=?
         AND status='pending'
         AND reminder_sent_at IS NOT NULL
       ORDER BY reminder_sent_at DESC, id DESC
       LIMIT 1`
    ).bind(uid).first();

    if (recent) {
      const task = await env.DB.prepare(
        "UPDATE tasks SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status='pending' RETURNING id,title"
      ).bind(recent.id, uid).first();
      if (task) return buildCompletionMessage(task, env);
    }
  }

  const completeMatch = text.match(/(?:完成|做完|完成任務)\s*#?(\d+)/u);
  if (completeMatch) {
    const id = Number(completeMatch[1]);
    const task = await env.DB.prepare(
      "UPDATE tasks SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? RETURNING id,title"
    ).bind(id, uid).first();
    return task ? buildCompletionMessage(task, env) : "找不到這個任務編號。";
  }

  const context = await activeTasksContext(env.DB, uid);
  const result = await interpretStructured(text, context, env);

  if (result.intent === "list_tasks") {
    return listTasksText(env.DB, uid);
  }

  if (result.intent === "complete_task" && Number.isInteger(result.task_id)) {
    const task = await env.DB.prepare(
      "UPDATE tasks SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? RETURNING id,title"
    ).bind(result.task_id, uid).first();
    return task ? buildCompletionMessage(task, env) : "找不到這個任務編號。";
  }

  if (result.intent === "propose_plan" || result.intent === "revise_plan") {
    const items = sanitizePlanItems(result.plan_items);
    if (items.length) {
      await setPendingPlan(env.DB, uid, { plan_items: items });
      return withPlanActions(`${result.reply || "我整理好了。"}\n\n📅 建議安排（尚未儲存）：\n${formatPlan(items)}\n\n選一下👇`);
    }
  }

  return result.reply || "請把待辦、期限或你想安排的事情告訴我。";
}


async function resolveReminderIntent(text, env) {
  const source = String(text || "").trim();
  if (!/(提醒|叫我|通知我|記得叫我|到時候)/u.test(source)) return null;

  // 1) Exact relative anchors from the user's own words are authoritative.
  const anchored = parseFlexibleRelativeReminder(source);
  if (anchored) return anchored;

  // 2) Keep fast deterministic parsing for very explicit absolute phrases.
  const deterministic = parseDeterministicReminder(source);
  if (deterministic) return deterministic;

  // 3) Let Gemini understand natural time language, then validate the result.
  const now = new Date();
  const taipeiNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    weekday: "long"
  }).format(now);

  const prompt = `你是一個只負責解析提醒時間的繁體中文時間理解器。
現在台灣時間：${taipeiNow}（${weekday}）
時區固定：Asia/Taipei。

請理解使用者自然語言中的提醒意圖，例如：
「明早八點叫我起床」
「下週五下午提醒我交報告」
「月底前提醒我繳房租」
「今晚睡前提醒我吃藥」
「晚一點提醒我回電話」

只輸出 JSON：
{
  "is_reminder": true,
  "title": "真正要做的事情",
  "remind_at": "ISO8601（必須含 +08:00）或 null",
  "time_is_ambiguous": false,
  "ambiguity_reason": ""
}

規則：
1. 不可輸出過去時間。
2. 明確日期、星期、時段依台灣時間解讀。
3. 「下午3點」= 15:00；「晚上8點」= 20:00。
4. 「三點半」= xx:30。
5. 若只有模糊時段：早上 09:00、下午 15:00、晚上 19:00、睡前 23:00。
6. 「晚一點」預設現在 + 2 小時。
7. 「月底前」若沒有更精確時間，設為本月底 20:00。
8. 無法合理判定才將 remind_at 設 null，絕對不要亂填。
9. title 只保留任務本身，不要包含「提醒我」。

使用者：${source}`;

  let raw;
  try {
    raw = await callGemini(prompt, env, true);
  } catch (err) {
    console.error("Reminder semantic parser failed", {
      name: err?.name || null,
      message: err?.message || String(err)
    });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return null;
  }

  if (!parsed?.is_reminder || !parsed?.title || !parsed?.remind_at) return null;

  const when = new Date(parsed.remind_at);
  if (Number.isNaN(when.getTime())) return null;

  // Safety margin: reject AI outputs that land in the past or essentially "now".
  if (when.getTime() <= Date.now() + 15000) {
    console.warn("Rejected invalid reminder time from Gemini", {
      remind_at: parsed.remind_at,
      source_length: source.length
    });
    return null;
  }

  return {
    title: String(parsed.title).trim().slice(0, 200),
    description: parsed.time_is_ambiguous
      ? `自然語言提醒（採預設時間）：${String(parsed.ambiguity_reason || "").slice(0, 300)}`
      : "自然語言提醒時間已解析並通過台灣時區驗證",
    first_step: String(parsed.title).trim().slice(0, 500),
    priority: 1,
    start_time: when.toISOString(),
    due_time: when.toISOString(),
    remind_at: when.toISOString(),
    estimated_minutes: null,
    reason: parsed.time_is_ambiguous
      ? "時間描述較模糊，使用預設時段並在儲存前讓使用者確認。"
      : "由 AI 理解自然時間語意，程式驗證時區與時間有效性。"
  };
}

function parseFlexibleRelativeReminder(text) {
  const s = String(text || "").trim();

  // 半小時後
  const half = s.match(/半\s*(小時|鐘頭)後(?:到時候)?\s*(?:提醒我|叫我|通知我)\s*(.+)$/u);
  if (half) return buildRelativeReminder(30, "分鐘", half[2], "半小時後");

  // Supports Arabic or common Chinese numbers and minutes/hours/days/weeks.
  const m = s.match(/(\d+(?:\.\d+)?|[零〇一二兩三四五六七八九十百]+)\s*(分鐘|分|小時|鐘頭|天|日|週|星期)後(?:到時候)?\s*(?:提醒我|叫我|通知我)\s*(.+)$/u);
  if (!m) return null;

  const amount = parseNaturalNumber(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = m[2];
  const title = String(m[3] || "").trim().replace(/[。！!]+$/u, "");
  if (!title) return null;

  let ms;
  if (unit === "分鐘" || unit === "分") ms = amount * 60 * 1000;
  else if (unit === "小時" || unit === "鐘頭") ms = amount * 60 * 60 * 1000;
  else if (unit === "天" || unit === "日") ms = amount * 24 * 60 * 60 * 1000;
  else ms = amount * 7 * 24 * 60 * 60 * 1000;

  const when = new Date(Date.now() + ms).toISOString();
  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${m[1]}${unit}後`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "直接依使用者原句中的相對時間計算，不交由 AI 猜測。"
  };
}

function parseNaturalNumber(input) {
  const s = String(input || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);

  const digits = { "零":0, "〇":0, "一":1, "二":2, "兩":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9 };
  if (s === "十") return 10;
  if (s === "百") return 100;

  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in digits) {
      current = digits[ch];
    } else if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else {
      return NaN;
    }
  }
  return total + current;
}

function buildRelativeReminder(amount, unit, rawTitle, rawTimeText) {
  const title = String(rawTitle || "").trim().replace(/[。！!]+$/u, "");
  if (!title) return null;
  const ms = unit === "分鐘"
    ? amount * 60 * 1000
    : amount * 60 * 60 * 1000;
  const when = new Date(Date.now() + ms).toISOString();
  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${rawTimeText}`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "直接依使用者原句中的相對時間計算，不交由 AI 猜測。"
  };
}

function parseDeterministicReminder(text) {
  return parseRelativeReminder(text) || parseAbsoluteReminder(text);
}

function parseAbsoluteReminder(text) {
  const s = String(text || "").trim();

  // Examples:
  // 今天晚上10:50提醒我叫弟弟起床
  // 明天下午3點提醒我交作業
  // 今天 22:30 到時候提醒我洗衣服
  const m = s.match(/^(今天|明天)?\s*(早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{1,2})|點(?:\s*(\d{1,2})\s*分?)?)?\s*(?:到時候)?\s*提醒我\s*(.+)$/u);
  if (!m) return null;

  const dayWord = m[1] || "今天";
  const part = m[2] || "";
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? m[5] ?? 0);
  const title = String(m[6] || "").trim().replace(/[。！!]+$/u, "");

  if (!title || !Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (part === "下午" || part === "晚上") {
    if (hour < 12) hour += 12;
  } else if (part === "中午") {
    if (hour < 11) hour += 12;
  } else if ((part === "早上" || part === "上午") && hour === 12) {
    hour = 0;
  }
  if (hour < 0 || hour > 23) return null;

  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  let y = get("year"), mo = get("month"), d = get("day");

  // Build target using Taipei wall-clock -> UTC by using +08:00 explicitly.
  const base = new Date(`${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00+08:00`);
  if (dayWord === "明天") base.setUTCDate(base.getUTCDate() + 1);

  const targetDate = new Date(base.getTime());
  // base above is midnight Taipei = previous day 16:00Z; adding local hour/minute is safe.
  targetDate.setTime(base.getTime() + hour * 3600000 + minute * 60000);

  // If user said "今天" and target already passed, reject instead of silently scheduling past.
  if (dayWord === "今天" && targetDate.getTime() <= now.getTime()) return null;

  const when = targetDate.toISOString();
  return {
    title: title.slice(0, 200),
    description: `指定時間提醒：${dayWord}${part}${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "依照使用者指定的絕對時間由程式精準計算，不交由 AI 推算。"
  };
}

function parseChineseNumber(input) {
  const s = String(input || "").trim();
  if (/^\d+$/.test(s)) return Number(s);

  const digitMap = {
    "零": 0, "〇": 0,
    "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? digitMap[a] : 1;
    const ones = b ? digitMap[b] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }

  return digitMap[s] ?? NaN;
}

function parseRelativeReminder(text) {
  const s = String(text || "").trim();
  const m = s.match(/(?:^|\s)(\d+|[零〇一二兩三四五六七八九十]+)\s*(分鐘|小時)後(?:到時候)?\s*提醒我\s*(.+)$/u);
  if (!m) return null;

  const amount = parseChineseNumber(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = m[2];
  const title = m[3].trim().replace(/[。！!]+$/u, "");
  if (!title) return null;

  const ms = unit === "小時" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
  const when = new Date(Date.now() + ms).toISOString();

  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${m[1]}${unit}後`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: `依照使用者指定的「${m[1]}${unit}後」精準計算，不交由 AI 推算。`
  };
}

function sanitizePlanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(x => x && typeof x === "object" && x.title && x.first_step)
    .slice(0, 20)
    .map(x => ({
      title: String(x.title).slice(0, 200),
      description: x.description ? String(x.description).slice(0, 1000) : null,
      first_step: String(x.first_step).slice(0, 500),
      priority: Number.isFinite(Number(x.priority)) ? Math.min(5, Math.max(1, Number(x.priority))) : 3,
      start_time: normalizeIso(x.start_time),
      due_time: normalizeIso(x.due_time),
      remind_at: normalizeIso(x.remind_at),
      estimated_minutes: x.estimated_minutes !== null && x.estimated_minutes !== undefined && x.estimated_minutes !== "" && Number.isFinite(Number(x.estimated_minutes))
        ? Math.max(1, Math.round(Number(x.estimated_minutes)))
        : null,
      reason: x.reason ? String(x.reason).slice(0, 500) : ""
    }));
}

function normalizeIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatPlan(items) {
  return items.map((x, i) => {
    const bits = [
      `${i + 1}. ${x.title}`,
      x.start_time ? `開始 ${fmtTaipei(x.start_time)}` : null,
      x.due_time ? `截止 ${fmtTaipei(x.due_time)}` : null,
      x.remind_at ? `提醒 ${fmtTaipei(x.remind_at)}` : null,
      x.estimated_minutes ? `${x.estimated_minutes} 分鐘` : null
    ].filter(Boolean);
    return bits.join("｜") + (x.reason ? `\n   原因：${x.reason}` : "");
  }).join("\n");
}

function fmtTaipei(v) {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(v));
  } catch {
    return String(v);
  }
}

async function interpretStructured(message, context, env) {
  const now = new Date();
  const taipeiNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    weekday: "long"
  }).format(now);

  const prompt = `你是繁體中文的 AI 行動管家。
你的工作是把自然語言待辦整理成可以執行的計畫。

現在台灣時間：${taipeiNow}（${weekday}）
時區：Asia/Taipei

現有待辦：
${context || "目前沒有"}

規則：
1. 使用者一次給多個任務時，全部處理。
2. 找出依賴關係、優先順序、第一步、合理開始時間與截止時間。
3. 不要假裝資料已經儲存；你只能提出方案。
4. 若資訊不足，不要亂編固定行程；可以用合理建議，但要保守。
5. 僅輸出 JSON，不要 markdown。
6. 所有「今天、明天、後天、週幾、本週、下週、月底」都必須以「現在台灣時間」換算成正確的台灣日期，不能用 UTC 日期直接推算。
7. 「下午」預設代表 13:00–17:59；若使用者只說下午，不要排到晚上。
8. 「週五前」代表最晚必須在本週五當天完成，不可排到週六或週日；若今天已經是週五，則視情況安排今天完成。
9. 若使用者明確給截止日，due_time 不得晚於該截止日。

JSON schema：
{
  "intent": "chat|propose_plan|revise_plan|list_tasks|complete_task",
  "reply": "給使用者看的繁體中文文字",
  "task_id": 3,
  "plan_items": [
    {
      "title": "任務名稱",
      "description": "補充",
      "first_step": "最小可執行第一步",
      "priority": 1,
      "start_time": "ISO8601 或 null",
      "due_time": "ISO8601 或 null",
      "remind_at": "ISO8601 或 null",
      "estimated_minutes": 60,
      "reason": "排序理由"
    }
  ]
}

使用者：
${message}`;

  let raw;
  try {
    raw = await callGemini(prompt, env, true);
  } catch (jsonErr) {
    console.error("Structured Gemini JSON mode failed, retrying plain mode", String(jsonErr));
    try {
      raw = await callGemini(prompt, env, false);
    } catch (plainErr) {
      console.error("Structured Gemini plain mode also failed", String(plainErr));
      return buildLocalFallback(message);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      console.error("Gemini returned non-JSON content; using local fallback");
      return buildLocalFallback(message);
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      console.error("Gemini JSON parse failed; using local fallback");
      return buildLocalFallback(message);
    }
  }

  const allowed = new Set(["chat","propose_plan","revise_plan","list_tasks","complete_task"]);
  if (!allowed.has(parsed.intent)) parsed.intent = "chat";
  if (typeof parsed.reply !== "string") parsed.reply = "";
  return parsed;
}

function buildLocalFallback(message) {
  const normalized = String(message || "")
    .replace(/^幫我安排[:：]?/u, "")
    .replace(/^幫我整理[:：]?/u, "")
    .trim();

  const parts = normalized
    .split(/[、，,；;\n]+/u)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 10);

  if (!parts.length) {
    return {
      intent: "chat",
      reply: "我有收到訊息，但 AI 暫時不穩。你可以直接把待辦一項一項列給我，我會先用保底模式整理。",
      task_id: null,
      plan_items: []
    };
  }

  const items = parts.map((p, i) => ({
    title: p.slice(0, 120),
    description: null,
    first_step: "先確認需要完成的具體內容與所需資料",
    priority: Math.min(5, i + 1),
    start_time: null,
    due_time: null,
    remind_at: null,
    estimated_minutes: null,
    reason: "AI 暫時不可用，先依輸入順序建立保底方案；之後可再調整時間與優先順序。"
  }));

  return {
    intent: "propose_plan",
    reply: "Gemini 目前回應不穩，我先用保底模式把任務整理出來，避免整段失敗。",
    task_id: null,
    plan_items: items
  };
}

async function interpretPlainText(message, env) {
  const prompt = `你是繁體中文的行動管家。
使用者會輸入待辦、期限、安排需求或一般問題。
請用繁體中文直接、精簡回答。
若使用者一次給多個任務，請幫他排序並提出合理的下一步。
不要假裝已儲存、已提醒或已建立任務，除非系統真的執行了資料寫入。

使用者：
${message}`;
  return callGemini(prompt, env, false);
}

async function callGemini(prompt, env, jsonMode) {
  const models = String(env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.6-flash")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 3);

  const controllers = models.map(() => new AbortController());

  const attempts = models.map((model, index) =>
    delayedGeminiAttempt(model, index * 1500, controllers[index], prompt, env, jsonMode)
  );

  try {
    const text = await Promise.any(attempts);
    controllers.forEach(c => c.abort());
    return text.slice(0, 9000);
  } catch (aggregateErr) {
    const errors = aggregateErr?.errors || [];
    console.error("All Gemini models failed", {
      models,
      errors: errors.map(e => ({
        name: e?.name || null,
        message: e?.message || String(e)
      }))
    });
    throw errors[errors.length - 1] || aggregateErr || new Error("all Gemini models failed");
  }
}

async function delayedGeminiAttempt(model, delayMs, controller, prompt, env, jsonMode) {
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (controller.signal.aborted) throw new DOMException("Cancelled after another model succeeded", "AbortError");
  }

  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: jsonMode ? 1200 : 900
    };
    if (jsonMode) generationConfig.responseMimeType = "application/json";

    const started = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig
        }),
        signal: controller.signal
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      console.error("Gemini HTTP error", {
        model,
        status: res.status,
        elapsed_ms: Date.now() - started,
        detail: detail.slice(0, 500)
      });
      throw new Error(`${model} -> ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map(p => p?.text || "")
      .join("")
      .trim();

    if (!text) throw new Error(`${model} returned empty response`);

    console.log("Gemini model succeeded", {
      model,
      elapsed_ms: Date.now() - started
    });

    return text;
  } catch (err) {
    if (!(err?.name === "AbortError" && controller.signal.aborted)) {
      console.error("Gemini model failed", {
        model,
        name: err?.name || null,
        message: err?.message || String(err),
        stack: err?.stack || null
      });
    } else {
      console.error("Gemini model aborted", {
        model,
        timeout_or_cancel: true
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function stripFence(text) {
  return String(text || "")
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "")
    .trim();
}

async function ensureSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      line_user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(line_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_time)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at)`
  ];

  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

async function rememberEvent(db, eventId) {
  const r = await db.prepare(
    "INSERT OR IGNORE INTO webhook_events(event_id) VALUES (?)"
  ).bind(eventId).run();
  return Number(r?.meta?.changes || 0) > 0;
}

async function ensureUser(db, uid) {
  await db.prepare(
    "INSERT OR IGNORE INTO users(line_user_id) VALUES (?)"
  ).bind(uid).run();
}

async function getPendingPlan(db, uid) {
  const row = await db.prepare(
    "SELECT plan_json FROM pending_plans WHERE line_user_id=?"
  ).bind(uid).first();
  if (!row?.plan_json) return null;
  try { return JSON.parse(row.plan_json); } catch { return null; }
}

async function setPendingPlan(db, uid, data) {
  await db.prepare(
    "INSERT INTO pending_plans(line_user_id,plan_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(line_user_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=CURRENT_TIMESTAMP"
  ).bind(uid, JSON.stringify(data)).run();
}

async function clearPendingPlan(db, uid) {
  await db.prepare("DELETE FROM pending_plans WHERE line_user_id=?").bind(uid).run();
}

async function savePlanTasks(db, uid, items) {
  const clean = sanitizePlanItems(items);
  if (!clean.length) return 0;
  const stmts = clean.map(x => db.prepare(
    `INSERT INTO tasks(
      line_user_id,title,description,first_step,priority,start_time,due_time,remind_at,estimated_minutes,status
    ) VALUES (?,?,?,?,?,?,?,?,?,'pending')`
  ).bind(
    uid, x.title, x.description, x.first_step, x.priority,
    x.start_time, x.due_time, x.remind_at, x.estimated_minutes
  ));
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + Number(r?.meta?.changes || 0), 0);
}

async function activeTasksContext(db, uid) {
  const r = await db.prepare(
    "SELECT id,title,status,start_time,due_time,first_step FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') ORDER BY COALESCE(due_time,'9999-12-31'), priority ASC LIMIT 40"
  ).bind(uid).all();
  return (r.results || []).map(t =>
    `id=${t.id};title=${t.title};status=${t.status};start=${t.start_time || ""};due=${t.due_time || ""};first_step=${t.first_step || ""}`
  ).join("\n");
}

async function listTasksText(db, uid) {
  const r = await db.prepare(
    "SELECT id,title,status,due_time FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') ORDER BY COALESCE(due_time,'9999-12-31'), priority ASC LIMIT 50"
  ).bind(uid).all();
  const rows = r.results || [];
  if (!rows.length) return "目前沒有待處理任務。";
  return "🟡 待處理：\n" + rows.map(t =>
    `#${t.id} ${t.title}｜${t.status}${t.due_time ? `｜截止 ${fmtTaipei(t.due_time)}` : ""}`
  ).join("\n");
}

async function ensureReminderColumn(db) {
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_sent_at TEXT").run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

async function processDueReminders(env, scheduledTime) {
  if (!env.DB || !env.CHANNEL_ACCESS_TOKEN) return;

  await ensureSchema(env.DB);
  await ensureReminderColumn(env.DB);

  const now = new Date(scheduledTime || Date.now()).toISOString();
  const due = await env.DB.prepare(
    `SELECT id,line_user_id,title,due_time,remind_at
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND remind_at <= ?
       AND reminder_sent_at IS NULL
     ORDER BY remind_at ASC
     LIMIT 50`
  ).bind(now).all();

  for (const task of (due.results || [])) {
    const text = {
      text: [
        `📌 ${task.title}`,
        task.due_time ? `⏰ 截止：${fmtTaipei(task.due_time)}` : null,
        "",
        "做完就直接按下面 👇"
      ].filter(x => x !== null).join("\n"),
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "message",
              label: "完成了✅",
              text: `完成 #${task.id}`
            }
          }
        ]
      }
    };

    try {
      await pushLine(task.line_user_id, text, env.CHANNEL_ACCESS_TOKEN);
      await env.DB.prepare(
        "UPDATE tasks SET reminder_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(task.id).run();
      console.log("Reminder pushed", { task_id: task.id });
    } catch (err) {
      console.error("Reminder push failed", {
        task_id: task.id,
        name: err?.name || null,
        message: err?.message || String(err)
      });
    }
  }
}

function buildCompletionMessage(task, env) {
  const base = String(
    env.PUBLIC_BASE_URL || "https://time-ai-assistant.410350515gin.workers.dev"
  ).replace(/\/$/, "");
  const index = Math.floor(Math.random() * REWARD_IMAGES_BASE64.length) + 1;

  return {
    text: `做完啦！🐽✨\n${task.title}\n這項我幫你收掉了。`,
    rewardImageUrl: `${base}/reward-images/${index}.jpg`
  };
}

function withPlanActions(text) {
  return {
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "好呀🐽", text: "好呀🐽" }
        },
        {
          type: "action",
          action: { type: "message", label: "我要改✏️", text: "我要改✏️" }
        },
        {
          type: "action",
          action: { type: "message", label: "先不要🙈", text: "先不要🙈" }
        }
      ]
    }
  };
}

function messageText(message) {
  if (message && typeof message === "object") return String(message.text || "");
  return String(message || "");
}

function toLineTextMessage(message) {
  if (message && typeof message === "object") {
    const out = {
      type: "text",
      text: String(message.text || "").slice(0, 5000)
    };
    if (message.quickReply) out.quickReply = message.quickReply;
    return out;
  }
  return { type: "text", text: String(message || "").slice(0, 5000) };
}

function toLineMessages(message) {
  const messages = [toLineTextMessage(message)];
  if (message && typeof message === "object" && message.rewardImageUrl) {
    messages.push({
      type: "image",
      originalContentUrl: message.rewardImageUrl,
      previewImageUrl: message.rewardImageUrl
    });
  }
  return messages;
}

async function pushLine(to, text, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      to,
      messages: toLineMessages(text)
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE push ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function replyLine(replyToken, text, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: toLineMessages(text)
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE reply ${res.status}: ${detail.slice(0, 300)}`);
  }
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

async function runReminderDiagnostics(env) {
  const result = {
    now: new Date().toISOString(),
    timezone: "Asia/Taipei",
    db_bound: Boolean(env.DB),
    pending_with_reminder: 0,
    due_now: 0,
    next_reminder: null,
    recent_tasks: []
  };

  if (!env.DB) return json(result, 503);

  await ensureSchema(env.DB);
  await ensureReminderColumn(env.DB);

  const now = new Date().toISOString();

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND reminder_sent_at IS NULL`
  ).first();

  const due = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND remind_at <= ?
       AND reminder_sent_at IS NULL`
  ).bind(now).first();

  const next = await env.DB.prepare(
    `SELECT id,title,remind_at,due_time,reminder_sent_at
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND reminder_sent_at IS NULL
     ORDER BY remind_at ASC
     LIMIT 1`
  ).first();

  const recent = await env.DB.prepare(
    `SELECT id,title,status,remind_at,due_time,reminder_sent_at
     FROM tasks
     ORDER BY id DESC
     LIMIT 8`
  ).all();

  result.pending_with_reminder = Number(pending?.n || 0);
  result.due_now = Number(due?.n || 0);
  result.next_reminder = next || null;
  result.recent_tasks = recent.results || [];
  return json(result);
}

async function runDiagnostics(env) {
  const result = {
    runtime: "cloudflare-workers",
    version: "0.2",
    db_bound: Boolean(env.DB),
    secrets: {
      GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
      CHANNEL_SECRET: Boolean(env.CHANNEL_SECRET),
      CHANNEL_ACCESS_TOKEN: Boolean(env.CHANNEL_ACCESS_TOKEN)
    },
    gemini: { ok: false, model: null, status: null },
    line: { ok: false, status: null },
    db: { ok: false, status: env.DB ? "bound" : "not_bound", tables: false }
  };

  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").first();
      result.db.ok = row?.ok === 1;
      result.db.tables = Boolean(table?.name);
      result.db.status = result.db.ok && result.db.tables ? "ok" : "query_failed";
    } catch (err) {
      result.db.status = String(err?.message || err);
    }
  }

  const models = String(env.GEMINI_MODELS || "gemini-3.8-flash")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  for (const model of models.slice(0, 2)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY || "")}`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with exactly OK" }] }],
            generationConfig: { maxOutputTokens: 8, temperature: 0 }
          }),
          signal: controller.signal
        }
      );
      clearTimeout(timeout);
      result.gemini.status = res.status;
      result.gemini.model = model;
      if (res.ok) {
        result.gemini.ok = true;
        break;
      }
    } catch (err) {
      result.gemini.status = String(err?.name || err);
      result.gemini.model = model;
    }
  }

  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN || ""}` }
    });
    result.line.status = res.status;
    result.line.ok = res.ok;
  } catch (err) {
    result.line.status = String(err?.name || err);
  }

  return json(result);
}
