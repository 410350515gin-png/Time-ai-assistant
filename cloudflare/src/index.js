const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ status: "ok", runtime: "cloudflare-workers", version: "0.1" });
    }

    if (request.method === "GET" && url.pathname === "/diag") {
      return runDiagnostics(env);
    }

    if (request.method === "POST" && (url.pathname === "/callback" || url.pathname === "/webhook")) {
      return handleLineWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
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
  for (const event of events) {
    if (event?.type !== "message" || event?.message?.type !== "text") continue;

    const text = (event.message.text || "").trim();
    console.log("LINE text event", { hasReplyToken: Boolean(event.replyToken), textLength: text.length });
    const replyToken = event.replyToken;
    if (!text || !replyToken) continue;

    let reply;
    try {
      reply = await interpretWithGemini(text, env);
      console.log("AI reply ready", { length: reply.length });
    } catch (err) {
      console.error("AI failed", err);
      reply = "AI 服務暫時繁忙，但 LINE 連線正常。請稍後再傳一次。";
    }

    try {
      await replyLine(replyToken, reply, env.CHANNEL_ACCESS_TOKEN);
      console.log("LINE reply sent successfully");
    } catch (err) {
      console.error("LINE reply failed", err);
    }
  }
}

async function interpretWithGemini(message, env) {
  const models = String(env.GEMINI_MODELS || "gemini-3.8-flash")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const prompt = `你是繁體中文的行動管家。
使用者會輸入待辦、期限、安排需求或一般問題。
請用繁體中文直接、精簡回答。
若使用者一次給多個任務，請幫他排序並提出合理的下一步。
不要假裝已儲存、已提醒或已建立任務，除非系統真的執行了資料寫入。

使用者：
${message}`;

  let lastError;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 1200
            }
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

      return text.slice(0, 4900);
    } catch (err) {
      lastError = err;
      console.error("Gemini model failed", model, String(err));
    }
  }

  throw lastError || new Error("all Gemini models failed");
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
    secrets: {
      GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
      CHANNEL_SECRET: Boolean(env.CHANNEL_SECRET),
      CHANNEL_ACCESS_TOKEN: Boolean(env.CHANNEL_ACCESS_TOKEN)
    },
    gemini: { ok: false, model: null, status: null },
    line: { ok: false, status: null }
  };

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
