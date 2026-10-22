from zoneinfo import ZoneInfo
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_ENV: str = "production"
    LOG_LEVEL: str = "INFO"
    TIMEZONE: str = "Asia/Taipei"
    LINE_CHANNEL_SECRET: str | None = None
    LINE_CHANNEL_ACCESS_TOKEN: str | None = None
    CHANNEL_SECRET: str | None = None
    CHANNEL_ACCESS_TOKEN: str | None = None
    GEMINI_API_KEY: str = Field(...)
    GEMINI_MODEL: str = "gemini-3.8-flash"
    DATABASE_URL: str = Field(...)
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @model_validator(mode="after")
    def normalize_line_credentials(self):
        if not self.LINE_CHANNEL_SECRET: self.LINE_CHANNEL_SECRET = self.CHANNEL_SECRET
        if not self.LINE_CHANNEL_ACCESS_TOKEN: self.LINE_CHANNEL_ACCESS_TOKEN = self.CHANNEL_ACCESS_TOKEN
        if not self.LINE_CHANNEL_SECRET or not self.LINE_CHANNEL_ACCESS_TOKEN:
            raise ValueError("Missing LINE credentials")
        return self

    @property
    def tz(self): return ZoneInfo(self.TIMEZONE)

    @property
    def sql_alchemy_db_url(self):
        return self.DATABASE_URL.replace("postgres://","postgresql://",1) if self.DATABASE_URL.startswith("postgres://") else self.DATABASE_URL

settings=Settings()
