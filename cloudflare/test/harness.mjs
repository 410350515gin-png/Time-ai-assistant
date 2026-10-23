// 測試用環境：用 Node 內建 SQLite 模擬 D1，並攔截 LINE / Gemini 的 HTTP 呼叫。
// 執行：cd cloudflare && node --test test/
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = pathToFileURL(path.join(here, "..", "src", "index.js")).href;
let importCounter = 0;

/** 每個測試拿一份全新的 Worker 模組（模組層級的快取不會互相影響）。 */
export async function loadWorker() {
  importCounter += 1;
  return (await import(`${workerPath}?v=${importCounter}`)).default;
}

// 跟真正的 D1 一樣：bind undefined 會報錯（D1_TYPE_ERROR）
const clean = args => args.map((v, i) => {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${i}`);
  return typeof v === "boolean" ? Number(v) : v;
});

class FakeStatement {
  constructor(d1, sql, args = []) {
    this.d1 = d1;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new FakeStatement(this.d1, this.sql, clean(args));
  }
  _stmt() {
    this.d1.maybeFail(this.sql);
    return this.d1.db.prepare(this.sql);
  }
  _run() {
    const st = this._stmt();
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = st.all(...this.args);
      return { results: rows, meta: { changes: rows.length } };
    }
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() { return this._run(); }
  async first() {
    const st = this._stmt();
    const row = /\bRETURNING\b/i.test(this.sql) ? st.all(...this.args)[0] : st.get(...this.args);
    return row ? { ...row } : null;
  }
  async all() {
    return { results: this._stmt().all(...this.args).map(r => ({ ...r })) };
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.failRules = []; // { pattern, times }
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(stmts) { return stmts.map(s => s._run()); }
  failNext(pattern, times = 1) { this.failRules.push({ pattern, times }); }
  maybeFail(sql) {
    const rule = this.failRules.find(r => r.times > 0 && r.pattern.test(sql));
    if (rule) {
      rule.times -= 1;
      throw new Error("D1_ERROR: simulated failure");
    }
  }
  exec(sql, ...args) { return this.db.prepare(sql).run(...clean(args)); }
  rows(sql, ...args) { return this.db.prepare(sql).all(...clean(args)).map(r => ({ ...r })); }
  row(sql, ...args) { return this.rows(sql, ...args)[0] || null; }
}

/** 模擬 LINE 與 Gemini。 */
export class FakeNetwork {
  constructor() {
    this.calls = [];
    this.retryKeys = new Set();
    this.pushFailures = [];   // 依序回傳的 HTTP status（空 = 成功）
    this.replyFailures = [];
    this.messageSeq = 1000;
    this.gemini = () => ({ intent: "chat", reply: "好喔🐽" });
    this.geminiStatus = [];   // 依序回傳的錯誤 status
    this.geminiCalls = [];
  }
  pushes() { return this.calls.filter(c => c.path === "/v2/bot/message/push"); }
  replies() { return this.calls.filter(c => c.path === "/v2/bot/message/reply"); }
  outgoing() { return this.calls.filter(c => c.path === "/v2/bot/message/push" || c.path === "/v2/bot/message/reply"); }
  lastText() {
    const out = this.outgoing();
    return out.length ? out[out.length - 1].body.messages[0].text || out[out.length - 1].body.messages[0].altText : null;
  }
  lastMessage() {
    const out = this.outgoing();
    return out.length ? out[out.length - 1].body.messages[0] : null;
  }
  json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  async fetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = null;
    try { body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
    const call = { host: url.host, path: url.pathname, headers, body };
    this.calls.push(call);

    if (url.host.includes("generativelanguage")) {
      const prompt = body?.contents?.[0]?.parts?.[0]?.text || "";
      this.geminiCalls.push({ model: decodeURIComponent(url.pathname.split("/models/")[1] || "").replace(/:generateContent$/, ""), prompt });
      const status = this.geminiStatus.shift();
      if (status) return this.json(status, { error: { code: status } });
      const userText = prompt.split("使用者：\n").pop();
      const out = this.gemini(userText, prompt);
      return this.json(200, { candidates: [{ content: { parts: [{ text: typeof out === "string" ? out : JSON.stringify(out) }] } }] });
    }

    if (url.pathname === "/v2/bot/message/push") {
      const key = headers["x-line-retry-key"];
      if (key && this.retryKeys.has(key)) return this.json(409, { message: "The retry key is already accepted" });
      const status = this.pushFailures.shift();
      if (status) return this.json(status, { message: "simulated" });
      if (key) this.retryKeys.add(key);
      return this.json(200, { sentMessages: body.messages.map(() => ({ id: String(this.messageSeq++), quoteToken: "q" })) });
    }
    if (url.pathname === "/v2/bot/message/reply") {
      const status = this.replyFailures.shift();
      if (status) return this.json(status, { message: "Invalid reply token" });
      return this.json(200, { sentMessages: body.messages.map(() => ({ id: String(this.messageSeq++), quoteToken: "q" })) });
    }
    if (url.pathname === "/v2/bot/chat/loading/start") return new Response("{}", { status: 202 });
    if (url.pathname === "/v2/bot/richmenu/list") return this.json(200, { richmenus: [] });
    if (url.pathname === "/v2/bot/richmenu") return this.json(200, { richMenuId: "richmenu-test" });
    if (url.pathname.startsWith("/v2/bot/richmenu/")) return this.json(200, {});
    if (url.pathname.startsWith("/v2/bot/user/all/richmenu/")) return this.json(200, {});
    if (url.pathname === "/v2/bot/info") return this.json(200, {});
    return this.json(404, { message: "unmocked " + url.pathname });
  }
}

export async function setup() {
  const worker = await loadWorker();
  const db = new FakeD1();
  const net = new FakeNetwork();
  globalThis.fetch = (input, init) => net.fetch(input, init);
  const queue = [];
  const queueControl = { failures: 0 };
  const env = {
    DB: db,
    GEMINI_QUEUE: {
      async sendBatch(msgs) {
        if (queueControl.failures > 0) { queueControl.failures -= 1; throw new Error("simulated queue outage"); }
        for (const m of msgs) queue.push(m.body);
      },
      async send(body) {
        if (queueControl.failures > 0) { queueControl.failures -= 1; throw new Error("simulated queue outage"); }
        queue.push(body);
      }
    },
    CHANNEL_SECRET: "secret",
    CHANNEL_ACCESS_TOKEN: "token",
    GEMINI_API_KEY: "gkey",
    ADMIN_TOKEN: "admin-token",
    PUBLIC_BASE_URL: "https://example.test",
    GEMINI_MODELS: "model-a,model-b"
  };

  let seq = 0;
  const h = {
    worker, db, net, env, queue, queueControl,

    /** 送 webhook，但「不等」waitUntil 的背景工作：用來確認回 200 之前已經做完的事。 */
    async webhookNoWait(events) {
      const raw = JSON.stringify({ destination: "x", events });
      const signature = createHmac("sha256", env.CHANNEL_SECRET).update(raw).digest("base64");
      const background = [];
      const res = await worker.fetch(new Request("https://worker.test/webhook", {
        method: "POST", headers: { "x-line-signature": signature, "content-type": "application/json" }, body: raw
      }), env, { waitUntil: p => background.push(p) });
      return { status: res.status, background };
    },

    async request(method, pathname, { headers = {}, body } = {}) {
      const pending = [];
      const ctx = { waitUntil: p => pending.push(p) };
      const res = await worker.fetch(new Request(`https://worker.test${pathname}`, { method, headers, body }), env, ctx);
      await Promise.all(pending);
      return res;
    },

    /** 送一個 LINE webhook；回傳 HTTP 狀態。 */
    async webhook(events) {
      const raw = JSON.stringify({ destination: "x", events });
      const signature = createHmac("sha256", env.CHANNEL_SECRET).update(raw).digest("base64");
      const res = await h.request("POST", "/webhook", { headers: { "x-line-signature": signature, "content-type": "application/json" }, body: raw });
      return res.status;
    },

    textEvent(text, opts = {}) {
      seq += 1;
      return {
        type: "message",
        webhookEventId: opts.eventId || `evt-${seq}`,
        replyToken: `rt-${seq}`,
        timestamp: opts.timestamp ?? Date.now(),
        source: { type: "user", userId: opts.uid || "U1" },
        message: { type: "text", id: `m-${seq}`, text, ...(opts.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}) }
      };
    },

    postbackEvent(data, opts = {}) {
      seq += 1;
      return {
        type: "postback",
        webhookEventId: opts.eventId || `evt-${seq}`,
        replyToken: `rt-${seq}`,
        timestamp: opts.timestamp ?? Date.now(),
        source: { type: "user", userId: opts.uid || "U1" },
        postback: { data }
      };
    },

    /** 處理 Queue 裡所有訊息（retry 的訊息會留在 queue）。回傳 { acked, retried }。 */
    async drainQueue() {
      const batch = queue.splice(0, queue.length);
      const result = { acked: 0, retried: 0 };
      const messages = batch.map((body, i) => ({
        id: `q${i}`, body, attempts: 1,
        ack() { result.acked += 1; },
        retry() { result.retried += 1; queue.push(body); }
      }));
      await worker.queue({ messages }, env);
      return result;
    },

    async cron(scheduledTime = Date.now()) {
      const pending = [];
      await worker.scheduled({ scheduledTime, cron: "* * * * *" }, env, { waitUntil: p => pending.push(p) });
      await Promise.all(pending);
    },

    async say(text, opts) {
      await h.webhook([h.textEvent(text, opts)]);
      await h.drainQueue();
      return net.lastText();
    },

    async tap(data, opts) {
      await h.webhook([h.postbackEvent(data, opts)]);
      if (queue.length) await h.drainQueue();
      return net.lastText();
    },

    /** 直接建立任務（測試用）。 */
    insertTask(fields) {
      const f = { line_user_id: "U1", title: "任務", first_step: "第一步", status: "pending", task_type: "daily", ...fields };
      const cols = Object.keys(f);
      const r = db.exec(`INSERT INTO tasks(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map(c => f[c]));
      return Number(r.lastInsertRowid);
    }
  };

  // 初始化 schema（等同 Worker 第一次被呼叫）
  await h.request("GET", "/diag/reminders", { headers: { authorization: "Bearer admin-token" } });
  net.calls.length = 0;
  return h;
}

/** 台灣時間 → ISO（測試用） */
export function tpe(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 8 * 3600000).toISOString();
}

/** 從 index.js 取出純函式做單元測試。 */
export async function loadPureFunctions(names) {
  const fs = await import("node:fs");
  const src = fs.readFileSync(fileURLToPath(workerPath), "utf8");
  const grab = n => {
    const i = src.search(new RegExp(`(^|\\n)(async )?function ${n}\\(`));
    if (i < 0) throw new Error("missing " + n);
    let depth = 0;
    for (let k = src.indexOf("{", i); k < src.length; k++) {
      if (src[k] === "{") depth++;
      if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
    }
  };
  const consts = "const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;";
  const body = consts + names.map(grab).join("\n") + `\nreturn { ${names.join(", ")} };`;
  return new Function(body)();
}
