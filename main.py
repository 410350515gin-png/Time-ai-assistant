
import os
import logging

from fastapi import FastAPI, Request, HTTPException, Header
from linebot.v3.webhook import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration,
    ApiClient,
    MessagingApi,
    ReplyMessageRequest,
    TextMessage,
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from google import genai


# =========================
# 1. 基本設定
# =========================

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
CHANNEL_SECRET = os.environ.get("CHANNEL_SECRET")
CHANNEL_ACCESS_TOKEN = os.environ.get("CHANNEL_ACCESS_TOKEN")

if not all([GEMINI_API_KEY, CHANNEL_SECRET, CHANNEL_ACCESS_TOKEN]):
    raise RuntimeError(
        "缺少環境變數，請檢查 Render 的 Environment 設定。"
    )

app = FastAPI()

configuration = Configuration(
    access_token=CHANNEL_ACCESS_TOKEN
)

handler = WebhookHandler(CHANNEL_SECRET)

ai_client = genai.Client(
    api_key=GEMINI_API_KEY
)


# =========================
# 2. AI 教練的人格設定
# =========================

COACH_SYSTEM_INSTRUCTION = """
你是「思緒整理員」，一位奉行 The ONE Thing
（專注只做一件事）的時間與行動教練。

你的指導哲學：

1. 拒絕死板表格與雜亂的長清單。
當使用者丟出一堆事情或感到焦慮混亂時，
你的任務是強迫收斂，不要給他長篇大論。

2. 找出第一張骨牌。
引導使用者找出現在唯一最關鍵的那件事。
這件事一旦啟動，其他事情的焦慮感就會減輕。

3. 微步啟動（Micro-step）。
把唯一的一件事拆成 2～5 分鐘內就能動手、
阻力極小的第一個動作。

4. 暫停其餘雜音。
明確告訴使用者，其他事情先全部放旁邊，
現在只看這一件。

5. 對話風格。
溫和、堅定、俐落。
每次回覆盡量控制在 100～150 個中文字內。
先安撫混亂的大腦，再給出單一焦點與一個微小行動。
"""


# =========================
# 3. 健康檢查
# =========================

@app.get("/")
def health():
    return {"status": "ok"}


# =========================
# 4. LINE Webhook
# =========================

@app.post("/callback")
async def callback(
    request: Request,
    x_line_signature: str = Header(
        default=None,
        alias="x-line-signature"
    ),
):
    body = (await request.body()).decode("utf-8")

    if not x_line_signature:
        raise HTTPException(
            status_code=400,
            detail="Missing LINE signature"
        )

    try:
        handler.handle(body, x_line_signature)

    except InvalidSignatureError:
        logger.warning("LINE 簽章驗證失敗")
        raise HTTPException(
            status_code=400,
            detail="Invalid signature"
        )

    except Exception:
        logger.exception("LINE Webhook 處理發生錯誤")
        raise HTTPException(
            status_code=500,
            detail="Webhook processing failed"
        )

    return {"status": "ok"}


# =========================
# 5. 接收訊息、呼叫 AI、回覆 LINE
# =========================

@handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event):
    user_text = event.message.text

    # 第一步：呼叫 Gemini
    try:
        response = ai_client.models.generate_content(
            model="gemini-3.8-flash",
            contents=user_text,
            config={
                "system_instruction": COACH_SYSTEM_INSTRUCTION
            },
        )

        reply_text = response.text

        if not reply_text or not reply_text.strip():
            reply_text = (
                "我們先不急著解決所有事情。"
                "告訴我，你現在最想先處理哪一件事？"
            )

    except Exception:
        logger.exception("Gemini API 呼叫失敗")

        reply_text = (
            "我剛剛整理思緒時出了點問題，"
            "請稍後再傳一次訊息。"
        )

    # 第二步：將訊息傳回 LINE
    try:
        with ApiClient(configuration) as api_client:
            line_bot_api = MessagingApi(api_client)

            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[
                        TextMessage(text=reply_text)
                    ],
                )
            )

        logger.info("LINE 回覆成功")

    except Exception:
        logger.exception("LINE 訊息回覆失敗")
