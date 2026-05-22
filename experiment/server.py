"""FastAPI server für das Zahlenreihen-Experiment.

Zwei Aufgaben in einem Server:
  1. Static-Files-Serving (ersetzt `python -m http.server`)
  2. POST /api/hint — proxiert Anfragen an die Anthropic-API,
     hält den API-Key serverseitig in `.env`.

Start (lokal):
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env  # dann ANTHROPIC_API_KEY in .env eintragen
    python server.py
    # Browser: http://localhost:8000

Architektur:
  - Frontend kennt den API-Key NIE — er bleibt in `.env`.
  - Konversations-State (Multi-Turn-History) liegt im Frontend; der Server
    ist stateless und bekommt die History bei jedem Request mitgeschickt.
  - Bei jeder Hint-Anfrage baut der Server den System-Prompt aus
    `prompts.py` zusammen, hängt die User-Message an, ruft Claude auf,
    gibt den Hint-Text zurück.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path
from typing import Literal

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from prompts import build_puzzle_context, build_static_system


# ---------- Setup ---------------------------------------------------------

# Logging auf stdout — hilft bei lokaler Entwicklung und beim Cost-Monitoring.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
)
log = logging.getLogger("hint-server")

# .env aus dem experiment/-Verzeichnis laden (egal von wo gestartet).
ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "claude-haiku-4-5").strip()

if not API_KEY or API_KEY.startswith("sk-ant-PASTE"):
    log.warning(
        "ANTHROPIC_API_KEY does not appear to be set. /api/hint will fail "
        "until you put a real key in `experiment/.env`."
    )

# anthropic-Client — wirft erst beim ersten Call, falls Key invalid.
# Wir lassen ihn auch ohne gültigen Key initialisieren, damit Static Files
# trotzdem ausgeliefert werden können (für Frontend-Entwicklung ohne API).
_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    """Lazy init des SDK-Clients — erlaubt Server-Start ohne Key."""
    global _client
    if _client is None:
        if not API_KEY or API_KEY.startswith("sk-ant-PASTE"):
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Add it to "
                "`experiment/.env` and restart the server."
            )
        _client = anthropic.Anthropic(api_key=API_KEY)
    return _client


# ---------- Request / Response-Schemas ------------------------------------

ALLOWED_CONDITIONS: tuple[str, ...] = ("direct", "strategy", "reflective")


class TrialPayload(BaseModel):
    """Was der Frontend pro Trial mitschickt."""

    id: str
    sequence: list[int]
    answer: int
    rule: str = ""


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class HintRequest(BaseModel):
    condition: str
    trial: TrialPayload
    history: list[HistoryMessage] = Field(default_factory=list)
    user_message: str | None = None  # null beim ersten Klick

    @field_validator("condition")
    @classmethod
    def _check_condition(cls, v: str) -> str:
        if v not in ALLOWED_CONDITIONS:
            raise ValueError(
                f"condition must be one of {ALLOWED_CONDITIONS}, got '{v}'"
            )
        return v


class HintResponse(BaseModel):
    hint: str
    model: str


# ---------- App / Routes --------------------------------------------------

app = FastAPI(title="Zahlenreihen-Experiment", docs_url=None, redoc_url=None)


# `Cache-Control: no-store` auf alles. Während der Entwicklung wechseln
# HTML/JS/CSS oft, und wenn der Browser eine ältere Version hält während
# eine neuere bereits geladen ist, gibt's silent JS-Errors (alte hints.js
# trifft auf neue main.js etc.). Im Pilot/Release könnte man das relaxen.
@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response


@app.post("/api/hint", response_model=HintResponse)
def post_hint(req: HintRequest) -> HintResponse:
    """Generiert einen Hint des angefragten Typs für den aktuellen Trial."""

    try:
        client = get_client()
    except RuntimeError as err:
        log.error(str(err))
        raise HTTPException(status_code=500, detail=str(err)) from err

    # System-Prompt: statischer Block (cacheable, falls je groß genug) +
    # per-trial Puzzle-Kontext.
    system_blocks = [
        {
            "type": "text",
            "text": build_static_system(req.condition),  # type: ignore[arg-type]
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": build_puzzle_context(req.trial.model_dump()),
        },
    ]

    # Messages: gesamte History + neue User-Message.
    # Beim ersten Hint-Klick (history leer, user_message=None) schicken wir
    # eine neutrale Eröffnungsfrage, damit das Modell weiß, was zu tun ist.
    user_message = req.user_message or "Please give me a hint for this puzzle."
    messages = [
        {"role": m.role, "content": m.content} for m in req.history
    ] + [{"role": "user", "content": user_message}]

    started = time.perf_counter()
    try:
        response = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=300,
            system=system_blocks,
            messages=messages,
        )
    except anthropic.AuthenticationError as err:
        log.error("Anthropic auth error: %s", err)
        raise HTTPException(
            status_code=500,
            detail="Anthropic API rejected the API key. Check `experiment/.env`.",
        ) from err
    except anthropic.RateLimitError as err:
        log.warning("Anthropic rate limit: %s", err)
        raise HTTPException(
            status_code=503,
            detail="Anthropic API rate-limited. Please wait a moment and try again.",
        ) from err
    except anthropic.APIError as err:
        log.error("Anthropic API error: %s", err)
        raise HTTPException(
            status_code=502,
            detail="Anthropic API returned an error.",
        ) from err

    latency_ms = int((time.perf_counter() - started) * 1000)

    # Erste Text-Block-Antwort einsammeln — sollte für unsere kurzen Hints
    # immer der einzige sein.
    hint_text = ""
    for block in response.content:
        if block.type == "text":
            hint_text = block.text.strip()
            break

    if not hint_text:
        log.error("Response without text block: %r", response.content)
        raise HTTPException(
            status_code=502,
            detail="Anthropic API returned an empty response.",
        )

    log.info(
        "hint condition=%s trial=%s latency=%dms in_tok=%d out_tok=%d",
        req.condition,
        req.trial.id,
        latency_ms,
        response.usage.input_tokens,
        response.usage.output_tokens,
    )

    return HintResponse(hint=hint_text, model=DEFAULT_MODEL)


# ---------- Static-Files-Serving ------------------------------------------
# Reihenfolge wichtig: erst spezifische Routen (oben), dann StaticFiles als
# Catch-all. /api/* muss vor StaticFiles registriert sein.

@app.get("/")
def root() -> FileResponse:
    return FileResponse(ROOT / "index.html")


# Mount muss zuletzt kommen — fängt sonst /api/* mit ein.
app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")
app.mount("/js", StaticFiles(directory=ROOT / "js"), name="js")


@app.get("/style.css")
def style() -> FileResponse:
    return FileResponse(ROOT / "style.css", media_type="text/css")


# ---------- Entrypoint ----------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    log.info("Starting server on http://localhost:%d (model: %s)", port, DEFAULT_MODEL)
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
