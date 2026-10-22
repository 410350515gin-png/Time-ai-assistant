import json,logging,re
from datetime import datetime
from google import genai
from app.config import settings
from app.agent.prompt import SYSTEM_COACH_PROMPT

logger=logging.getLogger(__name__)
ALLOWED={"chat","propose_plan","revise_plan","list_tasks","complete_task","postpone_task","cancel_task","pause_task","resume_task","stats","reject","help"}
client=genai.Client(api_key=settings.GEMINI_API_KEY)
BACKUP_MODELS=["gemini-3.5-flash-lite","gemini-3.6-flash"]

def _parse_json(text):
    text=(text or "").strip()
    if text.startswith("```"):
        text=re.sub(r"^```(?:json)?\s*|\s*```$","",text,flags=re.I|re.S).strip()
    try:
        return json.loads(text)
    except Exception:
        m=re.search(r"\{.*\}",text,re.S)
        if not m:
            raise
        return json.loads(m.group(0))

def _validate(d):
    if d.get("intent") not in ALLOWED:
        d["intent"]="chat"
    if not isinstance(d.get("reply"),str):
        d["reply"]="請告訴我你想處理的待辦。"
    return d

def _call_model(model,user_input):
    r=client.models.generate_content(
        model=model,
        contents=user_input,
        config={
            "system_instruction":SYSTEM_COACH_PROMPT,
            "response_mime_type":"application/json",
            "max_output_tokens":2500,
        },
    )
    return _validate(_parse_json(r.text))

def interpret_message(message,context=""):
    user_input=(
        f"現在時間：{datetime.now(settings.tz).isoformat()}\n"
        f"現有任務：\n{context}\n"
        f"使用者：{message}\n"
        "請嚴格只輸出一個 JSON 物件，不要加 markdown 或其他文字。"
    )
    models=[settings.GEMINI_MODEL,*BACKUP_MODELS]
    for model in models:
        try:
            result=_call_model(model,user_input)
            if model!=settings.GEMINI_MODEL:
                logger.warning("Gemini fallback model succeeded: %s",model)
            return result
        except Exception:
            logger.exception("Gemini model failed: %s",model)
    return {"intent":"chat","reply":"AI 服務暫時忙碌，請稍後再傳一次；你的任務資料沒有被寫入。"}
