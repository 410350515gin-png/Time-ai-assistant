import json,logging,re
from datetime import datetime
from google import genai
from app.config import settings
from app.agent.prompt import SYSTEM_COACH_PROMPT

logger=logging.getLogger(__name__)
ALLOWED={"chat","propose_plan","revise_plan","list_tasks","complete_task","postpone_task","cancel_task","pause_task","resume_task","stats","reject","help"}
client=genai.Client(api_key=settings.GEMINI_API_KEY)

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

def interpret_message(message,context=""):
    user_input=(
        f"現在時間：{datetime.now(settings.tz).isoformat()}\n"
        f"現有任務：\n{context}\n"
        f"使用者：{message}\n"
        "請嚴格只輸出一個 JSON 物件，不要加 markdown 或其他文字。"
    )
    try:
        interaction=client.interactions.create(
            model=settings.GEMINI_MODEL,
            system_instruction=SYSTEM_COACH_PROMPT,
            input=user_input,
            generation_config={"max_output_tokens":2500},
        )
        return _validate(_parse_json(interaction.output_text))
    except Exception:
        logger.exception("Interactions API failed; falling back to generate_content")
        try:
            r=client.models.generate_content(
                model=settings.GEMINI_MODEL,
                contents=user_input,
                config={
                    "system_instruction":SYSTEM_COACH_PROMPT,
                    "response_mime_type":"application/json",
                    "max_output_tokens":2500,
                },
            )
            return _validate(_parse_json(r.text))
        except Exception:
            logger.exception("Gemini fallback failed")
            return {"intent":"chat","reply":"AI 服務暫時忙碌，請稍後再傳一次；你的任務資料沒有被寫入。"}
