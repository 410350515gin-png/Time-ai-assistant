import json,logging
from datetime import datetime
from google import genai
from app.config import settings
from app.agent.prompt import SYSTEM_COACH_PROMPT

logger=logging.getLogger(__name__)
ALLOWED={"chat","propose_plan","revise_plan","list_tasks","complete_task","postpone_task","cancel_task","pause_task","resume_task","stats","reject","help"}

# Reuse one long-lived client for the process. Creating a temporary client
# inline can close the underlying HTTPX client before the request completes
# under the current Render/Python runtime.
client=genai.Client(api_key=settings.GEMINI_API_KEY)

def interpret_message(message,context=""):
    prompt=SYSTEM_COACH_PROMPT+f"\n現在時間：{datetime.now(settings.tz).isoformat()}\n現有任務：\n{context}\n使用者：{message}"
    try:
        r=client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=prompt,
            config={"response_mime_type":"application/json","temperature":0.2},
        )
        d=json.loads(r.text or "{}")
        if d.get("intent") not in ALLOWED:
            d["intent"]="chat"
        if not isinstance(d.get("reply"),str):
            d["reply"]="請告訴我你想處理的待辦。"
        return d
    except Exception:
        logger.exception("Gemini failed")
        return {"intent":"chat","reply":"我剛剛無法可靠理解，請再傳一次待辦與期限。"}
