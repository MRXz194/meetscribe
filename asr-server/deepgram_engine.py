"""Engine Deepgram: asr-server làm cầu nối giữa trình duyệt và Deepgram.

Vì sao không cho trình duyệt nối thẳng: tài liệu Deepgram không nói rõ cách gửi token tạm từ
WebSocket của trình duyệt, còn từ server thì dùng header `Authorization: Token <key>` chuẩn.
Như vậy key không bao giờ ra trình duyệt, và phía web dùng y nguyên giao thức như engine local.

    trình duyệt ── PCM16 2 kênh (meeting, mic) ──► asr-server ──► wss://api.deepgram.com/v1/listen
                ◄── partial / final (cùng định dạng engine local) ──┘    multichannel + diarize

- Kênh mic vẫn là "me" (Deepgram xử lý từng kênh riêng nhờ multichannel=true).
- Kênh meeting: người nói lấy từ diarization của Deepgram.
- Lọc tiếng vọng giữ nguyên logic is_echo của pipeline local.
- Lưu ý chi phí: Deepgram tính tiền theo từng kênh, 2 kênh = gấp đôi.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import time
import wave
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect

from pipeline import ECHO_HOLD_MS, SAMPLE_RATE, Final, is_echo

log = logging.getLogger("asr.deepgram")

DG_HOST = "api.deepgram.com"
MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-3")
LANGUAGE = os.environ.get("DEEPGRAM_LANGUAGE", "vi")
ENV_FILES = [Path(__file__).parent / ".env", Path(__file__).parent.parent / "meetscribe" / ".env.local"]


def api_key() -> str | None:
    """Đọc DEEPGRAM_API_KEY từ biến môi trường, không có thì từ asr-server/.env hoặc meetscribe/.env.local."""
    if os.environ.get("DEEPGRAM_API_KEY"):
        return os.environ["DEEPGRAM_API_KEY"]
    for path in ENV_FILES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*DEEPGRAM_API_KEY\s*=\s*(.+?)\s*$", line)
            if m and m.group(1):
                return m.group(1).strip("\"'")
    return None


def configured() -> bool:
    return bool(api_key())


# ---------------------------------------------------------------- realtime


class _State:
    """Chuyển kết quả Deepgram sang message của MeetScribe, giữ câu ở mic 1,5 s để lọc tiếng vọng."""

    def __init__(self, channels: list[str]) -> None:
        self.channels = channels
        self.echo_filter = "mic" in channels and len(channels) > 1
        self.partial: dict[str, str] = {}
        self.held: list[tuple[Final, float]] = []
        self.recent_meeting: list[Final] = []
        self.last_speaker = "1"
        self.next_id = 1

    def _speaker(self, channel: str, word: dict | None) -> str:
        if channel == "mic":
            return "me"
        if word is not None and word.get("speaker") is not None:
            self.last_speaker = str(int(word["speaker"]) + 1)
        return self.last_speaker

    def _partial_msg(self, channel: str) -> dict:
        pending = [f.text for f, _ in self.held if f.channel == channel]
        text = " ".join(pending + ([self.partial[channel]] if self.partial.get(channel) else []))
        speaker = "me" if channel == "mic" else self.last_speaker
        return {"type": "partial", "channel": channel, "speaker": speaker, "text": text}

    def handle(self, msg: dict) -> list[dict]:
        if msg.get("type") == "Error":
            log.warning("deepgram error: %s", msg)
            return []
        if msg.get("type") != "Results":
            return []
        idx = (msg.get("channel_index") or [0])[0]
        channel = self.channels[idx] if idx < len(self.channels) else self.channels[0]
        alt = (msg.get("channel", {}).get("alternatives") or [{}])[0]
        words = alt.get("words") or []
        out: list[dict] = []

        if not msg.get("is_final"):
            self.partial[channel] = alt.get("transcript", "")
            self._speaker(channel, words[0] if words else None)
            return [self._partial_msg(channel)]

        self.partial[channel] = ""
        # Một đoạn final có thể chứa nhiều người nói: tách theo từng cụm từ liên tiếp cùng người
        groups: list[tuple[str, list[dict]]] = []
        for w in words:
            spk = self._speaker(channel, w)
            if groups and groups[-1][0] == spk:
                groups[-1][1].append(w)
            else:
                groups.append((spk, [w]))
        for spk, ws in groups:
            text = " ".join(w.get("punctuated_word") or w.get("word", "") for w in ws).strip()
            if not text:
                continue
            final = Final(
                id=self.next_id,
                channel=channel,
                speaker=spk,
                text=text,
                start_ms=int(ws[0]["start"] * 1000),
                end_ms=int(ws[-1]["end"] * 1000),
            )
            self.next_id += 1
            if channel == "mic" and self.echo_filter:
                self.held.append((final, time.monotonic()))
            else:
                if channel == "meeting":
                    self.recent_meeting.append(final)
                out.append(final.to_json())
        out.append(self._partial_msg(channel))
        return out

    def release(self, force: bool) -> list[dict]:
        now = time.monotonic()
        ready = [(f, t) for f, t in self.held if force or (now - t) * 1000 >= ECHO_HOLD_MS]
        if not ready:
            return []
        self.held = [h for h in self.held if h not in ready]
        latest = max((f.end_ms for f in self.recent_meeting), default=0)
        self.recent_meeting = [f for f in self.recent_meeting if latest - f.end_ms < 15000]
        out = [f.to_json() for f, _ in ready if not is_echo(f, self.recent_meeting)]
        return out + [self._partial_msg("mic")]


def _stream_url(n_channels: int) -> str:
    params = {
        "model": MODEL,
        "language": LANGUAGE,
        "encoding": "linear16",
        "sample_rate": SAMPLE_RATE,
        "channels": n_channels,
        "multichannel": "true" if n_channels > 1 else "false",
        "interim_results": "true",
        "punctuate": "true",
        "smart_format": "true",
        "diarize": "true",
        "endpointing": 300,
    }
    return f"wss://{DG_HOST}/v1/listen?{urlencode(params)}"


async def run_stream(ws: WebSocket, channels: list[str]) -> None:
    """Xử lý một phiên ghi sau khi trình duyệt gửi start với engine=deepgram."""
    key = api_key()
    if not key:
        await ws.send_json({"type": "error", "message": "Chưa có DEEPGRAM_API_KEY trong meetscribe/.env.local"})
        return
    try:
        dg = await connect(
            _stream_url(len(channels)),
            additional_headers={"Authorization": f"Token {key}"},
            open_timeout=10,
            max_size=None,
        )
    except Exception as err:  # noqa: BLE001 - key sai, hết credit, mất mạng… đều báo cho người dùng
        log.warning("deepgram connect failed: %s", err)
        await ws.send_json({"type": "error", "message": f"Không kết nối được Deepgram: {err}"})
        return

    state = _State(channels)
    frame_bytes = 2 * len(channels)
    stopped = asyncio.Event()
    started = time.perf_counter()
    audio_bytes = 0
    log.info("deepgram session start channels=%s model=%s", channels, MODEL)
    await ws.send_json({"type": "ready"})

    async def browser_to_deepgram() -> None:
        nonlocal audio_bytes
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()
            if msg.get("bytes") is not None:
                pcm = msg["bytes"][: len(msg["bytes"]) // frame_bytes * frame_bytes]
                audio_bytes += len(pcm)
                await dg.send(pcm)
            elif msg.get("text") and json.loads(msg["text"]).get("type") == "stop":
                # Deepgram xử lý nốt phần audio đã nhận, gửi kết quả cuối rồi tự đóng kết nối
                await dg.send(json.dumps({"type": "CloseStream"}))
                stopped.set()
                return

    async def deepgram_to_browser() -> None:
        async for raw in dg:
            for out in state.handle(json.loads(raw)):
                await ws.send_json(out)

    async def ticker() -> None:
        while True:
            await asyncio.sleep(0.3)
            for out in state.release(force=False):
                await ws.send_json(out)

    reader = asyncio.create_task(deepgram_to_browser())
    tick = asyncio.create_task(ticker())
    try:
        sender = asyncio.create_task(browser_to_deepgram())
        done, _ = await asyncio.wait({sender, reader}, return_when=asyncio.FIRST_COMPLETED)
        if sender in done:
            sender.result()  # ném lỗi nếu trình duyệt rớt kết nối
            await asyncio.wait_for(reader, timeout=30)
        else:
            reader.result()
            if not stopped.is_set():
                raise RuntimeError("Deepgram đóng kết nối giữa chừng (kiểm tra key hoặc credit)")
        for out in state.release(force=True):
            await ws.send_json(out)
        for name in channels:
            await ws.send_json({"type": "partial", "channel": name, "speaker": "", "text": ""})
        await ws.send_json({"type": "done"})
        log.info(
            "deepgram session done audio=%.1fs wall=%.1fs",
            audio_bytes / frame_bytes / SAMPLE_RATE,
            time.perf_counter() - started,
        )
    finally:
        tick.cancel()
        reader.cancel()
        await dg.close()


# ---------------------------------------------------------------- file


def transcribe_pcm(pcm16: bytes) -> list[dict]:
    """Gửi cả file (PCM16 mono 16 kHz) lên Deepgram, trả về câu theo người nói giống engine local."""
    key = api_key()
    if not key:
        raise RuntimeError("Chưa có DEEPGRAM_API_KEY trong meetscribe/.env.local")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm16)
    params = {
        "model": MODEL,
        "language": LANGUAGE,
        "diarize": "true",
        "punctuate": "true",
        "smart_format": "true",
        "utterances": "true",
    }
    res = httpx.post(
        f"https://{DG_HOST}/v1/listen",
        params=params,
        headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
        content=buf.getvalue(),
        timeout=600,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Deepgram {res.status_code}: {res.text[:300]}")
    utterances = res.json().get("results", {}).get("utterances") or []
    return [
        {
            "type": "final",
            "id": i + 1,
            "channel": "meeting",
            "speaker": str(int(u.get("speaker", 0)) + 1),
            "text": u["transcript"],
            "startMs": int(u["start"] * 1000),
            "endMs": int(u["end"] * 1000),
        }
        for i, u in enumerate(utterances)
        if u.get("transcript")
    ]
