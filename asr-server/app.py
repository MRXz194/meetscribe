"""MeetScribe ASR server: speech-to-text tiếng Việt miễn phí, chạy local trên CPU.

Chạy:  .venv/Scripts/python.exe -m uvicorn app:app --port 8000

WebSocket /ws
  client → {"type": "start", "sampleRate": 16000, "channels": ["meeting", "mic"]}
  client → <binary> PCM16 little-endian, interleaved theo thứ tự channels, ~100 ms/frame
  client → {"type": "stop"}
  server → {"type": "ready"}
  server → {"type": "partial", "channel", "speaker", "text"}      chữ tạm, thay thế mỗi lần
  server → {"type": "final", "id", "channel", "speaker", "text", "startMs", "endMs"}
  (sau stop)
  server → {"type": "status", "message": "refining"}
  server → {"type": "final_transcript", "segments": [...], "speakers": n}  nhãn người nói bản cuối
  server → {"type": "done"}

POST /transcribe   body = PCM16 mono 16 kHz  →  {"segments": [...], "durationSec": n}
GET  /health
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import deepgram_engine
from silence import SilenceWatch
from pipeline import ASR_MODEL_DIR, SAMPLE_RATE, Models, Session, transcribe_pcm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("asr")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if o.strip()
]
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def origin_allowed(headers, client_host: str | None) -> bool:
    """Chặn trang web lạ dùng ké server (và credit Deepgram) của người dùng.

    CORS chỉ bảo vệ HTTP; WebSocket thì trình duyệt vẫn cho mở từ mọi trang, nên phải tự kiểm tra Origin.
    Trình duyệt luôn gửi Origin; client không phải trình duyệt (curl, script) chỉ được nếu gọi từ chính máy này.
    """
    origin = headers.get("origin")
    if origin:
        return origin in ALLOWED_ORIGINS
    return client_host in LOOPBACK


app = FastAPI(title="MeetScribe ASR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def warm_up() -> None:
    t = time.perf_counter()
    await asyncio.to_thread(Models.get)
    log.info("models loaded in %.2fs (%s)", time.perf_counter() - t, ASR_MODEL_DIR.name)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": ASR_MODEL_DIR.name,
        "engines": {"local": True, "deepgram": deepgram_engine.configured()},
    }


@app.websocket("/ws")
async def transcribe_stream(ws: WebSocket) -> None:
    if not origin_allowed(ws.headers, ws.client.host if ws.client else None):
        log.warning("ws rejected: origin=%s", ws.headers.get("origin"))
        await ws.close(code=1008)
        return
    await ws.accept()
    session: Session | None = None
    watch: SilenceWatch | None = None
    frame_bytes = 2
    audio_sec = proc_sec = 0.0
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("text") is not None:
                data = json.loads(msg["text"])
                if data.get("type") == "start":
                    if data.get("sampleRate", SAMPLE_RATE) != SAMPLE_RATE:
                        await ws.send_json({"type": "error", "message": "Chỉ nhận 16 kHz"})
                        break
                    channels = data.get("channels") or ["meeting"]
                    if data.get("engine") == "deepgram":
                        # Từ đây phiên do cầu nối Deepgram xử lý đến hết (kể cả stop)
                        await deepgram_engine.run_stream(ws, channels, data.get("language"))
                        break
                    session = Session(channels)
                    watch = SilenceWatch(channels)
                    frame_bytes = 2 * len(channels)
                    log.info("session start channels=%s", channels)
                    await ws.send_json({"type": "ready"})
                elif data.get("type") == "stop" and session:
                    for out in await asyncio.to_thread(session.finish):
                        await ws.send_json(out)
                    # Bản cuối: diarization offline trên cả cuộc họp rồi gán lại nhãn người nói
                    await ws.send_json({"type": "status", "message": "refining"})
                    t = time.perf_counter()
                    try:
                        refined = await asyncio.to_thread(session.refine)
                    except Exception:  # noqa: BLE001 - lỗi bước này thì vẫn giữ nhãn live
                        log.exception("refine failed")
                        refined = None
                    if refined:
                        await ws.send_json(refined)
                    await ws.send_json({"type": "done"})
                    log.info(
                        "session done audio=%.1fs cpu=%.2fs rtf=%.3f live_speakers=%d final_speakers=%s refine=%.1fs %s",
                        audio_sec, proc_sec, proc_sec / max(audio_sec, 1e-6), len(session.speakers.sums),
                        refined["speakers"] if refined else "-", time.perf_counter() - t,
                        watch.summary() if watch else "",
                    )
                    break
            elif msg.get("bytes") is not None and session:
                pcm = msg["bytes"]
                pcm = pcm[: len(pcm) // frame_bytes * frame_bytes]
                t = time.perf_counter()
                outs = await asyncio.to_thread(session.feed, pcm)
                if watch:
                    watch.feed(pcm)
                    outs += watch.poll()
                proc_sec += time.perf_counter() - t
                audio_sec += len(pcm) / frame_bytes / SAMPLE_RATE
                for out in outs:
                    await ws.send_json(out)
    except WebSocketDisconnect:
        pass
    except Exception as err:  # noqa: BLE001 - báo lỗi cho client thay vì đóng câm
        log.exception("session failed")
        try:
            await ws.send_json({"type": "error", "message": str(err)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


@app.post("/transcribe")
async def transcribe_file(request: Request, engine: str = "local", language: str | None = None) -> dict:
    if not origin_allowed(request.headers, request.client.host if request.client else None):
        return JSONResponse({"error": "Origin không được phép"}, status_code=403)
    pcm = await request.body()
    pcm = pcm[: len(pcm) // 2 * 2]
    t = time.perf_counter()
    run = (lambda pcm: deepgram_engine.transcribe_pcm(pcm, language)) if engine == "deepgram" else transcribe_pcm
    try:
        segments = await asyncio.to_thread(run, pcm)
    except RuntimeError as err:
        return JSONResponse({"error": str(err)}, status_code=502)
    duration = len(pcm) / 2 / SAMPLE_RATE
    log.info("file %.1fs processed by %s in %.1fs", duration, engine, time.perf_counter() - t)
    return {"segments": segments, "durationSec": round(duration)}
