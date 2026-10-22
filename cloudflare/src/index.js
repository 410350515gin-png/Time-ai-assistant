const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const YES = new Set(["是","好","確認","確認執行","同意","可以","ok","yes","好啊","照這個安排","確認計畫"]);
const NO = new Set(["否","不要","取消","不用","no","先不要","不接受"]);

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

    if (request.method === "POST" && (url.pathname === "/callback" || url.pathname === "/webhook")) {
      return handleLineWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
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

  ctx.waitUntil(processLineEvents(events, env));
  return json({ status: "accepted" });
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
      console.error("Message processing failed", err);
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
    return `✅ 已儲存 ${saved} 項任務。你之後可以問我「列出任務」、說「完成 #3」，或再叫我重新安排。`;
  }

  if (pending && NO.has(lower)) {
    await clearPendingPlan(env.DB, uid);
    return "好的，這次沒有套用任何變更。";
  }

  if (/^(列出|查看|顯示).*(任務|待辦)|^(任務|待辦)(清單)?$/u.test(text)) {
    return listTasksText(env.DB, uid);
  }

  const completeMatch = text.match(/(?:完成|做完|完成任務)\s*#?(\d+)/u);
  if (completeMatch) {
    const id = Number(completeMatch[1]);
    const task = await env.DB.prepare(
      "UPDATE tasks SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? RETURNING id,title"
    ).bind(id, uid).first();
    return task ? `✅ 已完成 #${task.id} ${task.title}` : "找不到這個任務編號。";
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
    return task ? `✅ 已完成 #${task.id} ${task.title}` : "找不到這個任務編號。";
  }

  if (result.intent === "propose_plan" || result.intent === "revise_plan") {
    const items = sanitizePlanItems(result.plan_items);
    if (items.length) {
      await setPendingPlan(env.DB, uid, { plan_items: items });
      return `${result.reply || "我整理好了。"}\n\n📅 建議安排（尚未儲存）：\n${formatPlan(items)}\n\n回覆「確認」才會真正寫入；也可以直接告訴我要怎麼修改，或回覆「取消」。`;
    }
  }

  return result.reply || "請把待辦、期限或你想安排的事情告訴我。";
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
      estimated_minutes: Number.isFinite(Number(x.estimated_minutes)) ? Math.max(1, Math.round(Number(x.estimated_minutes))) : null,
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
  const prompt = `你是繁體中文的 AI 行動管家。
你的工作是把自然語言待辦整理成可以執行的計畫。

現在時間：${new Date().toISOString()}
時區：Asia/Taipei

現有待辦：
${context || "目前沒有"}

規則：
1. 使用者一次給多個任務時，全部處理。
2. 找出依賴關係、優先順序、第一步、合理開始時間與截止時間。
3. 不要假裝資料已經儲存；你只能提出方案。
4. 若資訊不足，不要亂編固定行程；可以用合理建議，但要保守。
5. 僅輸出 JSON，不要 markdown。

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
  const models = String(env.GEMINI_MODELS || "gemini-3.8-flash")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  let lastError;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const generationConfig = {
        temperature: 0.2,
        maxOutputTokens: jsonMode ? 1200 : 900
      };
      if (jsonMode) generationConfig.responseMimeType = "application/json";

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

      clearTimeout(timeout);

      if (!res.ok) {
        const detail = await res.text();
        lastError = new Error(`${model} -> ${res.status}: ${detail.slice(0, 300)}`);
        if ([429, 500, 502, 503, 504].includes(res.status)) continue;
        throw lastError;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text || "")
        .join("")
        .trim();

      if (!text) {
        lastError = new Error(`${model} returned empty response`);
        continue;
      }

      return text.slice(0, 9000);
    } catch (err) {
      lastError = err;
      console.error("Gemini model failed", model, String(err));
    }
  }

  throw lastError || new Error("all Gemini models failed");
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

async function replyLine(replyToken, text, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text || "").slice(0, 5000) }]
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
