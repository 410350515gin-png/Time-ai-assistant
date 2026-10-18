from fastapi import FastAPI, Request, HTTPException, Header
from linebot.v3.webhook import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration,
    ApiClient,
    MessagingApi,
    ReplyMessageRequest,
    TextMessage
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from google import genai
import os

# 從雲端系統環境變數讀取（安全標準寫法）
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
CHANNEL_SECRET = os.environ.get("CHANNEL_SECRET")
CHANNEL_ACCESS_TOKEN = os.environ.get("CHANNEL_ACCESS_TOKEN")

app = FastAPI()
configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(CHANNEL_SECRET)
ai_client = genai.Client(api_key=GEMINI_API_KEY)

COACH_SYSTEM_INSTRUCTION = """
你是「思緒整理員」，一位奉行「The ONE Thing（專注只做一件事）」的時間與行動教練。
你的指導哲學：
1. 拒絕死板表格與雜亂的長清單。當使用者丟出一堆事情或感到焦慮混亂時，你的任務是「強迫收斂」，絕對不要給他長篇大論。
2. 找出第一張骨牌：引導他找出「現在唯一最關鍵的那件事（The ONE Thing）」。這件事一旦啟動，其他事情的焦慮感就會減半。
3. 微步啟動（Micro-step）：把那唯一的一件事，拆成「2~5 分鐘內就能動手、阻力極小」的極簡第一個動作。
4. 暫停其餘雜音：明確告訴他「其他事情先全部放旁邊，現在我們只看這一件」。
5. 對話風格：溫和、堅定、俐落。每次回覆簡短（不超過 100~150 字），先安撫混亂的大腦，直接給出單一焦點與一個微小行動。
"""

@app.get("/")
def health():
    return {"status": "ok"}

@app.post("/callback")
async def callback(request: Request, x_line_signature: str = Header(None)):
    body = (await request.body()).decode("utf-8")
    try:
        handler.handle(body, x_line_signature)
    except InvalidSignatureError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    return "OK"

@handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event):
    user_text = event.message.text
    response = ai_client.models.generate_content(
        model="gemini-2.5-flash",
        contents=user_text,
        config={"system_instruction": COACH_SYSTEM_INSTRUCTION}
    )
    reply_text = response.text

    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        line_bot_api.reply_message(
            ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[TextMessage(text=reply_text)]
            )
        )
