"""FastAPI server für das Zahlenreihen-Experiment.

Zwei Aufgaben in einem Server:
  1. Static-Files-Serving (ersetzt `python -m http.server`)
  2. POST /api/hint — proxiert Anfragen an die OpenAI-API (GPT),
     hält den API-Key serverseitig in `.env`.

Start (lokal):
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env  # dann OPENAI_API_KEY in .env eintragen
    python server.py
    # Browser: http://localhost:8000

Architektur:
  - Frontend kennt den API-Key NIE — er bleibt in `.env`.
  - Konversations-State (Multi-Turn-History) liegt im Frontend; der Server
    ist stateless und bekommt die History bei jedem Request mitgeschickt.
  - Bei jeder Hint-Anfrage baut der Server den System-Prompt aus
    `prompts.py` zusammen, hängt die User-Message an, ruft GPT auf,
    gibt den Hint-Text zurück.
"""

from __future__ import annotations

import json
import logging
import os
import re
import socket
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import openai
from openai import OpenAI
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
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

# Ergebnis-CSVs landen serverseitig hier (auf dem Host-Rechner). So bekommt
# der Versuchsleiter die Daten auch dann, wenn ein Teilnehmer das Experiment
# über die LAN-IP auf einem anderen Gerät spielt. Verzeichnis ist gitignored.
RESULTS_DIR = ROOT / "data" / "results"

# Round-Robin-Zuweisung der Hint-Bedingung über alle Teilnehmer hinweg.
# Reihenfolge: direct -> strategy -> reflective -> direct -> ...
# Control wurde aus dem Studien-Design genommen und ist deshalb nicht mehr in
# der Rotation. Wieder aufnehmen = einfach "control" zurück ins Tuple.
ASSIGNMENT_CONDITIONS: tuple[str, ...] = ("direct", "strategy", "reflective")

# Optionaler manueller Override der Zuweisung. Ist FORCE_CONDITION auf eine
# gültige Gruppe gesetzt, bekommt JEDER neue Teilnehmer genau diese Bedingung;
# das Round-Robin und der persistente Zähler bleiben dabei unangetastet, laufen
# nach dem Entfernen des Overrides also sauber weiter. Gedacht, um eine
# unterrepräsentierte Gruppe gezielt aufzuholen (z. B. FORCE_CONDITION=reflective).
# Leer => normales Round-Robin.
FORCE_CONDITION = os.environ.get("FORCE_CONDITION", "").strip().lower()

# Der Zählerstand muss Server-Neustarts überleben. Auf Free-Tier-Hosting ist
# die lokale Platte flüchtig (Cold Start nach Idle = leeres Dateisystem); der
# Datei-Zähler springt dann auf 0 zurück und ALLE bekämen "direct". Deshalb in
# Produktion ein persistenter, atomarer Zähler in Upstash (Redis-REST); die
# Datei dient nur noch als lokaler Fallback für die Entwicklung (gitignored).
COUNTER_FILE = ROOT / "data" / "condition-counter.txt"
UPSTASH_COUNTER_KEY = "expra-condition-counter"

API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini").strip()

# Optionales Zugangstoken. Sobald gesetzt, müssen /api/hint und /api/results
# es im Header `X-Access-Token` mitschicken — verhindert, dass Fremde den
# öffentlich erreichbaren Proxy aufrufen und OpenAI-Kosten verursachen.
# Leer => kein Check (für lokale Entwicklung im vertrauten Netz).
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()

# Optionaler Webhook (z.B. Google-Apps-Script-Web-App). Wenn gesetzt, schickt
# der Server jede fertige Ergebnis-CSV zusätzlich dorthin. Nötig im Cloud-
# Hosting, wo die lokale Platte ephemer ist (Restart/Sleep löscht sie).
RESULTS_WEBHOOK_URL = os.environ.get("RESULTS_WEBHOOK_URL", "").strip()

# Upstash-Redis-Zugang für den persistenten Bedingungs-Zähler (REST-API).
# Beide Werte stehen im Upstash-Dashboard unter "REST API". Leer => lokaler
# Datei-Zähler (siehe COUNTER_FILE). In Render als Env-Vars hinterlegen.
UPSTASH_REDIS_REST_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "").strip().rstrip("/")
UPSTASH_REDIS_REST_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "").strip()


def _key_looks_unset(value: str) -> bool:
    """True wenn der Key fehlt oder noch der Platzhalter aus .env.example ist."""
    if not value:
        return True
    placeholders = ("sk-PASTE", "sk-...", "your-key-here", "PASTE")
    return any(value.startswith(p) for p in placeholders)


if _key_looks_unset(API_KEY):
    log.warning(
        "OPENAI_API_KEY does not appear to be set. /api/hint will fail "
        "until you put a real key in `docs/.env`."
    )

# OpenAI-Client — wirft erst beim ersten Call, falls Key invalid.
# Wir lassen ihn auch ohne gültigen Key initialisieren, damit Static Files
# trotzdem ausgeliefert werden können (für Frontend-Entwicklung ohne API).
_client: OpenAI | None = None


def get_client() -> OpenAI:
    """Lazy init des SDK-Clients — erlaubt Server-Start ohne Key."""
    global _client
    if _client is None:
        if _key_looks_unset(API_KEY):
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Add it to "
                "`docs/.env` and restart the server."
            )
        _client = OpenAI(api_key=API_KEY)
    return _client


# ---------- Request / Response-Schemas ------------------------------------

ALLOWED_CONDITIONS: tuple[str, ...] = ("direct", "strategy", "reflective", "control")


class TrialPayload(BaseModel):
    """Was der Frontend pro Trial mitschickt.

    `sequence` sind die sichtbaren Tokens (Strings, damit führende Nullen wie
    "019" erhalten bleiben), OHNE die Lücke. `blank_index` gibt an, an welcher
    Position die gesuchte Zahl ("?") sitzt — Default ist ans Ende.
    """

    id: str
    sequence: list[str]
    blank_index: int | None = None
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


class ResultsRequest(BaseModel):
    """Fertige CSV vom Frontend, die der Server auf dem Host ablegt."""

    participant_id: str = ""
    condition: str = ""
    csv: str


class ResultsResponse(BaseModel):
    saved_as: str


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


def require_token(provided: str | None) -> None:
    """Wirft 401, wenn ACCESS_TOKEN gesetzt ist und nicht (exakt) passt."""
    if not ACCESS_TOKEN:
        return  # kein Token konfiguriert -> offener Zugang (lokal)
    if (provided or "").strip() != ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing access token.")


@app.post("/api/hint", response_model=HintResponse)
def post_hint(
    req: HintRequest,
    x_access_token: str | None = Header(default=None),
) -> HintResponse:
    """Generiert einen Hint des angefragten Typs für den aktuellen Trial."""

    require_token(x_access_token)

    try:
        client = get_client()
    except RuntimeError as err:
        log.error(str(err))
        raise HTTPException(status_code=500, detail=str(err)) from err

    # OpenAI: ein einzelner System-Prompt (BASE + condition + Puzzle-Kontext).
    # OpenAI cached Prefix-Tokens automatisch ab gewisser Länge — kein
    # explizites cache_control wie bei Anthropic nötig.
    system_text = (
        build_static_system(req.condition)  # type: ignore[arg-type]
        + "\n\n"
        + build_puzzle_context(req.trial.model_dump())
    )

    # Messages für Chat Completions: erst System, dann History, dann neue
    # User-Message. Beim ersten Hint-Klick (history leer, user_message=None)
    # schicken wir eine neutrale Eröffnungsfrage, damit das Modell weiß, was
    # zu tun ist.
    user_message = req.user_message or "Please give me a hint for this puzzle."
    messages: list[dict] = [{"role": "system", "content": system_text}]
    messages.extend({"role": m.role, "content": m.content} for m in req.history)
    messages.append({"role": "user", "content": user_message})

    started = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=DEFAULT_MODEL,
            max_tokens=300,
            messages=messages,
        )
    except openai.AuthenticationError as err:
        log.error("OpenAI auth error: %s", err)
        raise HTTPException(
            status_code=500,
            detail="OpenAI API rejected the API key. Check `docs/.env`.",
        ) from err
    except openai.RateLimitError as err:
        log.warning("OpenAI rate limit: %s", err)
        raise HTTPException(
            status_code=503,
            detail="OpenAI API rate-limited. Please wait a moment and try again.",
        ) from err
    except openai.APIError as err:
        log.error("OpenAI API error: %s", err)
        raise HTTPException(
            status_code=502,
            detail="OpenAI API returned an error.",
        ) from err

    latency_ms = int((time.perf_counter() - started) * 1000)

    # Chat-Completions liefert die Antwort in choices[0].message.content.
    hint_text = (response.choices[0].message.content or "").strip()

    if not hint_text:
        log.error("Response without content: %r", response)
        raise HTTPException(
            status_code=502,
            detail="OpenAI API returned an empty response.",
        )

    usage = response.usage
    log.info(
        "hint condition=%s trial=%s latency=%dms in_tok=%d out_tok=%d",
        req.condition,
        req.trial.id,
        latency_ms,
        getattr(usage, "prompt_tokens", 0) if usage else 0,
        getattr(usage, "completion_tokens", 0) if usage else 0,
    )

    return HintResponse(hint=hint_text, model=DEFAULT_MODEL)


def _sanitize_filename(value: str, fallback: str) -> str:
    """Nur unkritische Zeichen zulassen — verhindert Path-Traversal."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", value or "").strip("_")
    return cleaned or fallback


def _forward_to_webhook(filename: str, req: ResultsRequest) -> None:
    """Schickt die CSV an RESULTS_WEBHOOK_URL (z.B. Google Apps Script).

    Best-effort: Fehler werden nur geloggt, nicht an den Teilnehmer
    durchgereicht — der Browser-Download bleibt als Fallback.
    """
    if not RESULTS_WEBHOOK_URL:
        return
    payload = json.dumps(
        {
            "filename": filename,
            "participant_id": req.participant_id,
            "condition": req.condition,
            "csv": req.csv,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        RESULTS_WEBHOOK_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            # Google blockt den Default-User-Agent von urllib ("Python-urllib")
            # mit 403. Ein browser-/curl-artiger UA wird durchgelassen.
            "User-Agent": "Mozilla/5.0 (compatible; ExpraHintsServer/1.0)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as resp:
            resp.read()  # Antwort verwerfen; Status reicht.
        log.info("results forwarded to webhook file=%s", filename)
    except Exception as err:  # noqa: BLE001 - bewusst breit, Best-effort
        log.error("Could not forward results to webhook: %s", err)


@app.post("/api/results", response_model=ResultsResponse)
def post_results(
    req: ResultsRequest,
    x_access_token: str | None = Header(default=None),
) -> ResultsResponse:
    """Speichert die CSV: lokal (best-effort) + optional an einen Webhook.

    Im Cloud-Hosting ist die lokale Platte ephemer — dort sorgt der Webhook
    (RESULTS_WEBHOOK_URL) für die eigentliche Persistenz.
    """
    require_token(x_access_token)

    safe_id = _sanitize_filename(req.participant_id, "anon")
    safe_cond = _sanitize_filename(req.condition, "unknown")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    filename = f"experiment_{safe_id}_{safe_cond}_{ts}.csv"

    # Lokale Kopie (best-effort) — funktioniert lokal, schadet in der Cloud nicht.
    wrote_local = False
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        (RESULTS_DIR / filename).write_text(req.csv, encoding="utf-8")
        wrote_local = True
    except OSError as err:
        log.warning("Could not write local results file %s: %s", filename, err)

    # Cloud-Persistenz via Webhook (falls konfiguriert).
    _forward_to_webhook(filename, req)

    # Nur hart fehlschlagen, wenn weder lokal gespeichert noch ein Webhook da ist.
    if not wrote_local and not RESULTS_WEBHOOK_URL:
        raise HTTPException(
            status_code=500, detail="Could not save results on the host."
        )

    log.info("results saved participant=%s condition=%s file=%s", safe_id, safe_cond, filename)
    return ResultsResponse(saved_as=filename)


def _read_counter() -> int:
    """Liest den Round-Robin-Counter; bei fehlender Datei oder Lesefehler → 0."""
    try:
        return int(COUNTER_FILE.read_text().strip())
    except (OSError, ValueError):
        return 0


def _write_counter(n: int) -> None:
    """Persistiert den Counter; Fehler werden geloggt, nicht geworfen."""
    try:
        COUNTER_FILE.parent.mkdir(parents=True, exist_ok=True)
        COUNTER_FILE.write_text(str(n))
    except OSError as err:
        log.warning("Could not persist condition counter: %s", err)


def _upstash_incr() -> int:
    """Erhöht den Bedingungs-Zähler atomar in Upstash und gibt den neuen Wert.

    Nutzt die Upstash-REST-API (POST /incr/<key>, Bearer-Token). INCR ist
    atomar — selbst wenn zwei Teilnehmer exakt gleichzeitig starten, bekommt
    keiner dieselbe Zahl. Erster Aufruf auf einem frischen Key liefert 1.
    """
    request = urllib.request.Request(
        f"{UPSTASH_REDIS_REST_URL}/incr/{UPSTASH_COUNTER_KEY}",
        headers={"Authorization": f"Bearer {UPSTASH_REDIS_REST_TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as resp:
        data = json.loads(resp.read())
    return int(data["result"])


def _next_index() -> int:
    """Nächster 0-basierter Round-Robin-Index für die Bedingungszuweisung.

    Produktion: atomarer Upstash-Zähler (überlebt Server-Neustarts). Ist
    Upstash nicht konfiguriert oder gerade nicht erreichbar, greift der lokale
    Datei-Zähler als Fallback — der reicht für die lokale Entwicklung.
    """
    if UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN:
        try:
            return _upstash_incr() - 1  # INCR liefert 1 beim ersten Teilnehmer
        except (OSError, ValueError, KeyError) as err:
            log.error("Upstash-Zähler nicht erreichbar, nutze lokalen Datei-Fallback: %s", err)
    n = _read_counter()
    _write_counter(n + 1)
    return n


@app.get("/api/condition")
def get_condition(x_access_token: str | None = Header(default=None)) -> dict:
    """Weist Teilnehmer im Round-Robin einer Bedingung zu.

    Reihenfolge direct → strategy → reflective → direct → …
    Damit ist die Verteilung über N Teilnehmer maximal um 1 ungleich
    (z. B. bei 9 Teilnehmern: 3·direct + 3·strategy + 3·reflective).
    Der Zählerstand liegt in Produktion persistent in Upstash (siehe
    _next_index), damit Server-Neustarts ihn nicht auf 0 zurücksetzen.
    Token-gated wie die anderen API-Endpoints, damit Fremde den Counter
    nicht aus dem Takt bringen können.
    """
    require_token(x_access_token)

    # Manueller Override (z. B. um Reflective aufzuholen): feste Gruppe für alle,
    # Round-Robin + Zähler bleiben unangetastet. Ungültiger Wert => ignorieren.
    if FORCE_CONDITION:
        if FORCE_CONDITION in ASSIGNMENT_CONDITIONS:
            log.info("condition FORCED via FORCE_CONDITION -> %s", FORCE_CONDITION)
            return {"condition": FORCE_CONDITION, "index": -1, "forced": True}
        log.warning(
            "FORCE_CONDITION='%s' ist keine gültige Gruppe %s — ignoriere, nutze Round-Robin",
            FORCE_CONDITION, ASSIGNMENT_CONDITIONS,
        )

    n = _next_index()
    condition = ASSIGNMENT_CONDITIONS[n % len(ASSIGNMENT_CONDITIONS)]
    log.info("assigned condition #%d -> %s", n, condition)
    return {"condition": condition, "index": n}


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

def _local_ip() -> str:
    """Ermittelt die LAN-IP dieses Rechners (ohne echten Traffic zu senden)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # Route bestimmen; es fliessen keine Daten.
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    # Default 0.0.0.0: erlaubt Zugriff von anderen Geräten im selben Netzwerk.
    # Über HOST=127.0.0.1 lässt sich der Server auf den eigenen Rechner begrenzen.
    host = os.environ.get("HOST", "0.0.0.0").strip()

    log.info("Starting server (model: %s)", DEFAULT_MODEL)
    log.info("  Local:   http://localhost:%d", port)
    if host == "0.0.0.0":
        log.info("  Network: http://%s:%d  (share this with testers on the same Wi-Fi)", _local_ip(), port)
        log.warning(
            "Server is reachable on your local network without authentication — "
            "only run it on a trusted network. Results CSVs are saved to %s",
            RESULTS_DIR,
        )
    uvicorn.run("server:app", host=host, port=port, reload=False)
