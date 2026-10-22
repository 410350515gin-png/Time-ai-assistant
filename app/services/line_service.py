import logging
from linebot.v3 import WebhookParser
from linebot.v3.messaging import Configuration,ApiClient,MessagingApi,ReplyMessageRequest,PushMessageRequest,TextMessage
from app.config import settings
logger=logging.getLogger(__name__)
config=Configuration(access_token=settings.LINE_CHANNEL_ACCESS_TOKEN)
line_parser=WebhookParser(settings.LINE_CHANNEL_SECRET)
def _msgs(texts): return [TextMessage(text=t[:4900]) for t in texts if t and t.strip()][:5]
def reply_message(token,texts):
    try:
        with ApiClient(config) as c: MessagingApi(c).reply_message(ReplyMessageRequest(reply_token=token,messages=_msgs(texts)))
        return True
    except Exception: logger.exception("LINE reply failed"); return False
def push_message(uid,texts):
    try:
        with ApiClient(config) as c: MessagingApi(c).push_message(PushMessageRequest(to=uid,messages=_msgs(texts)))
        return True
    except Exception: logger.exception("LINE push failed"); return False
