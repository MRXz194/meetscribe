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
- Rớt kết nối tới Deepgram thì tự nối lại, giữ tối đa 60 s audio gửi bù (xem run_stream).
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
import numpy as np
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from pipeline import ECHO_HOLD_MS, SAMPLE_RATE, Final, Models, diarize_turns, is_echo, label_by_turns
from silence import SilenceWatch

log = logging.getLogger("asr.deepgram")

DG_HOST = "api.deepgram.com"
DG_WS_URL = os.environ.get("DEEPGRAM_WS_URL", f"wss://{DG_HOST}/v1/listen")  # đổi được để test với server giả
MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-3")
LANGUAGE = os.environ.get("DEEPGRAM_LANGUAGE", "vi")
# Đã đo với nova-3: "vi" nhận tiếng Việt rất tốt và xử lý được phần tiếng Anh xen kẽ ở mức vừa; "multi" (code-switching) cho
# tiếng Anh tốt nhất nhưng KHÔNG hỗ trợ tiếng Việt (ra chữ sai hoặc rỗng); "en" chỉ cho họp hoàn toàn tiếng Anh.
LANGUAGES = {"vi", "en", "multi"}


def pick_language(value: str | None) -> str:
    return value if value in LANGUAGES else LANGUAGE
# Chi phí: giới hạn số phiên cùng lúc và độ dài một phiên để lỡ quên tắt cũng không đốt credit
MAX_SESSIONS = int(os.environ.get("DEEPGRAM_MAX_SESSIONS", "2"))
# Chỉ để gỡ lỗi: đặt thư mục này thì lưu nguyên audio nhận từ trình duyệt (PCM16 xen kẽ các kênh) để phát lại. Mặc định tắt.
DEBUG_DUMP_DIR = os.environ.get("DEEPGRAM_DEBUG_DUMP")
MAX_SESSION_SEC = int(os.environ.get("DEEPGRAM_MAX_SESSION_SEC", str(4 * 3600)))
# Rớt kết nối tới Deepgram: giữ tối đa chừng này audio chờ gửi bù, thử nối lại với thời gian chờ tăng dần
RECONNECT_BUFFER_SEC = 60
RECONNECT_DELAYS = [0.5, 1, 2, 4, 8, 8, 8]
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
        # Sau khi nối lại, Deepgram tính giờ và đánh số người nói lại từ đầu
        self.offset_ms = 0
        self.spk_base = 0
        self.max_label = 0
        # Từng từ của mọi câu đã phát (kèm giờ), để khi dừng gán lại người nói theo diarization offline
        self.words: dict[int, list[Final]] = {}
        self.emitted_words: list[Final] = []

    def on_reconnect(self, offset_ms: int) -> None:
        """Phiên Deepgram mới: cộng bù thời gian, và coi người nói là nhãn mới thay vì gộp nhầm với nhãn cũ."""
        self.offset_ms = offset_ms
        self.spk_base = self.max_label
        self.partial = {}

    def _speaker(self, channel: str, word: dict | None) -> str:
        if channel == "mic":
            return "me"
        if word is not None and word.get("speaker") is not None:
            label = int(word["speaker"]) + 1 + self.spk_base
            self.max_label = max(self.max_label, label)
            self.last_speaker = str(label)
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
                start_ms=int(ws[0]["start"] * 1000) + self.offset_ms,
                end_ms=int(ws[-1]["end"] * 1000) + self.offset_ms,
            )
            self.next_id += 1
            self.words[final.id] = [
                Final(0, channel, spk, w.get("punctuated_word") or w.get("word", ""),
                      int(w["start"] * 1000) + self.offset_ms, int(w["end"] * 1000) + self.offset_ms)
                for w in ws
            ]
            if channel == "mic" and self.echo_filter:
                self.held.append((final, time.monotonic()))
            else:
                if channel == "meeting":
                    self.recent_meeting.append(final)
                out.append(self._emit(final))
        out.append(self._partial_msg(channel))
        return out

    def release(self, force: bool) -> list[dict]:
        # Luôn dọn recent_meeting, kể cả khi không ghi mic (không có câu chờ), để họp dài không phình bộ nhớ
        latest = max((f.end_ms for f in self.recent_meeting), default=0)
        self.recent_meeting = [f for f in self.recent_meeting if latest - f.end_ms < 15000]
        now = time.monotonic()
        ready = [(f, t) for f, t in self.held if force or (now - t) * 1000 >= ECHO_HOLD_MS]
        if not ready:
            return []
        self.held = [h for h in self.held if h not in ready]
        out = [self._emit(f) for f, _ in ready if not is_echo(f, self.recent_meeting)]
        for f, _ in ready:
            self.words.pop(f.id, None)
        return out + [self._partial_msg("mic")]

    def _emit(self, final: Final) -> dict:
        self.emitted_words += self.words.pop(final.id, [])
        return final.to_json()

    def refine(self, meeting_audio: list) -> dict | None:
        """Diarization trực tiếp của Deepgram hay gộp mọi người vào 1 nhãn ở phút đầu và tách sai giữa câu.
        Khi dừng: chạy diarization offline (giống engine local) trên audio kênh meeting, gán người nói cho TỪNG TỪ
        rồi gom lại thành câu. Không tốn thêm tiền Deepgram. None nếu không chạy được → giữ nhãn live."""
        turns = diarize_turns(Models.get(), meeting_audio)
        if not turns or not self.emitted_words:
            return None
        labeled, n = label_by_turns(self.emitted_words, turns)
        segments: list[dict] = []
        for w in labeled:
            last = segments[-1] if segments else None
            if (
                last
                and last["channel"] == w["channel"]
                and last["speaker"] == w["speaker"]
                and w["startMs"] - last["endMs"] < 2000
            ):
                last["text"] += " " + w["text"]
                last["endMs"] = w["endMs"]
            else:
                segments.append({**w, "id": len(segments) + 1})
        return {"type": "final_transcript", "segments": segments, "speakers": n}


def _stream_url(n_channels: int, language: str) -> str:
    params = {
        "model": MODEL,
        "language": language,
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
    return f"{DG_WS_URL}?{urlencode(params)}"


_active = 0


async def run_stream(ws: WebSocket, channels: list[str], language: str | None = None) -> None:
    """Xử lý một phiên ghi sau khi trình duyệt gửi start với engine=deepgram."""
    global _active
    language = pick_language(language)
    key = api_key()
    if not key:
        await ws.send_json({"type": "error", "message": "Chưa có DEEPGRAM_API_KEY trong meetscribe/.env.local"})
        return
    if _active >= MAX_SESSIONS:
        await ws.send_json({"type": "error", "message": f"Đang có {_active} phiên Deepgram, tối đa {MAX_SESSIONS}"})
        return

    async def open_dg():
        return await connect(
            _stream_url(len(channels), language),
            additional_headers={"Authorization": f"Token {key}"},
            open_timeout=10,
            max_size=None,
        )

    try:
        first = await open_dg()
    except Exception as err:  # noqa: BLE001 - key sai, hết credit, mất mạng… đều báo cho người dùng
        log.warning("deepgram connect failed: %s", err)
        await ws.send_json({"type": "error", "message": f"Không kết nối được Deepgram: {err}"})
        return

    _active += 1
    state = _State(channels)
    frame_bytes = 2 * len(channels)
    max_pending = RECONNECT_BUFFER_SEC * SAMPLE_RATE * frame_bytes
    stopped = asyncio.Event()
    close_sent = False  # đã gửi CloseStream: Deepgram trả nốt rồi đóng, không cần nối lại nữa
    watch = SilenceWatch(channels)
    meeting_idx = channels.index("meeting") if "meeting" in channels else None
    meeting_audio: list[np.ndarray] = []  # kênh meeting (int16) cho bước diarization offline khi dừng
    dump = None
    if DEBUG_DUMP_DIR:
        Path(DEBUG_DUMP_DIR).mkdir(parents=True, exist_ok=True)
        dump = open(Path(DEBUG_DUMP_DIR) / f"{time.strftime('%H%M%S')}-{'_'.join(channels)}.pcm", "wb")
    started = time.perf_counter()
    audio_bytes = 0  # tổng audio đã nhận từ trình duyệt
    pending = bytearray()  # audio nhận được lúc đang mất kết nối Deepgram
    # Kết nối Deepgram hiện tại, None khi đang nối lại. Gán ngay kết nối đầu: trình duyệt gửi audio từ trước khi
    # nhận "ready", nếu để None thì frame đầu rơi vào hàng chờ và bị mất.
    dg = first
    log.info("deepgram session start channels=%s model=%s language=%s", channels, MODEL, language)
    await ws.send_json({"type": "ready"})

    async def browser_to_deepgram() -> None:
        nonlocal audio_bytes, close_sent
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()
            if msg.get("bytes") is not None:
                pcm = msg["bytes"][: len(msg["bytes"]) // frame_bytes * frame_bytes]
                audio_bytes += len(pcm)
                watch.feed(pcm)
                if meeting_idx is not None:
                    meeting_audio.append(
                        np.frombuffer(pcm, dtype=np.int16).reshape(-1, len(channels))[:, meeting_idx].copy()
                    )
                if dump is not None:
                    dump.write(pcm)
                if dg is not None:
                    try:
                        await dg.send(pcm)
                        continue
                    except ConnectionClosed:
                        pass  # supervisor sẽ nối lại; frame này vào hàng chờ
                pending.extend(pcm)
                if len(pending) > max_pending:
                    # Bỏ phần cũ nhất; offset thời gian được tính lại từ phần còn giữ khi nối lại
                    del pending[: len(pending) - max_pending]
            elif msg.get("text") and json.loads(msg["text"]).get("type") == "stop":
                stopped.set()
                if dg is not None:
                    try:
                        # Deepgram xử lý nốt phần audio đã nhận, gửi kết quả cuối rồi tự đóng kết nối
                        await dg.send(json.dumps({"type": "CloseStream"}))
                        close_sent = True
                    except ConnectionClosed:
                        pass  # supervisor thấy stopped sẽ nối lại, gửi bù rồi đóng
                return

    async def supervisor() -> None:
        """Đọc kết quả Deepgram; rớt kết nối giữa chừng thì nối lại và gửi bù audio đã giữ."""
        nonlocal dg, close_sent
        conn = first
        retry = 0
        n_results = n_text = 0
        while True:
            dg = conn
            try:
                async for raw in conn:
                    msg = json.loads(raw)
                    if msg.get("type") == "Results":
                        n_results += 1
                        alt = (msg.get("channel", {}).get("alternatives") or [{}])[0]
                        if alt.get("transcript"):
                            n_text += 1
                            if n_text <= 3:
                                log.info("deepgram first text results: ch=%s final=%s %r", msg.get("channel_index"), msg.get("is_final"), alt["transcript"][:80])
                    elif msg.get("type") != "Metadata":
                        log.info("deepgram message: %s", str(msg)[:200])
                    for out in state.handle(msg):
                        await ws.send_json(out)
            except ConnectionClosed:
                pass
            dg = None
            log.info(
                "deepgram connection closed code=%s reason=%r stopped=%s pending=%dB results=%d with_text=%d",
                conn.close_code, conn.close_reason, stopped.is_set(), len(pending), n_results, n_text,
            )
            if close_sent or (stopped.is_set() and not pending):
                return
            # Rớt giữa chừng, hoặc đã bấm dừng nhưng còn audio chưa gửi: nối lại
            await ws.send_json({"type": "status", "message": "reconnecting"})
            while True:
                if retry >= len(RECONNECT_DELAYS):
                    raise RuntimeError("Mất kết nối Deepgram và không nối lại được (kiểm tra mạng, key hoặc credit)")
                await asyncio.sleep(RECONNECT_DELAYS[retry])
                retry += 1
                try:
                    conn = await open_dg()
                    break
                except Exception as err:  # noqa: BLE001
                    log.warning("deepgram reconnect %d failed: %s", retry, err)
            # Không có await giữa lúc tính offset và lúc lấy pending nên con số này chính xác
            state.on_reconnect((audio_bytes - len(pending)) * 1000 // (frame_bytes * SAMPLE_RATE))
            while pending:
                chunk = bytes(pending)
                pending.clear()
                await conn.send(chunk)
            if stopped.is_set():
                await conn.send(json.dumps({"type": "CloseStream"}))
                close_sent = True
            retry = 0
            log.info("deepgram reconnected, offset=%dms", state.offset_ms)

    async def ticker() -> None:
        while True:
            await asyncio.sleep(0.3)
            if time.perf_counter() - started > MAX_SESSION_SEC:
                raise RuntimeError(f"Phiên Deepgram quá {MAX_SESSION_SEC // 3600} giờ, tự dừng để tránh tốn credit")
            for out in state.release(force=False) + watch.poll():
                await ws.send_json(out)

    tasks = [
        asyncio.create_task(browser_to_deepgram()),
        asyncio.create_task(supervisor()),
        asyncio.create_task(ticker()),
    ]
    sender, sup, tick = tasks
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if tick in done:
            tick.result()
        if sup in done:
            sup.result()  # ném lỗi nếu nối lại thất bại
        # Tới đây: trình duyệt đã gửi stop (hoặc rớt kết nối, sender.result() sẽ ném)
        await asyncio.wait_for(asyncio.gather(sender, sup), timeout=60)
        for out in state.release(force=True):
            await ws.send_json(out)
        for name in channels:
            await ws.send_json({"type": "partial", "channel": name, "speaker": "", "text": ""})
        await ws.send_json({"type": "status", "message": "refining"})
        t = time.perf_counter()
        try:
            refined = await asyncio.to_thread(state.refine, meeting_audio)
        except Exception:  # noqa: BLE001 - lỗi bước này thì vẫn giữ nhãn live
            log.exception("deepgram refine failed")
            refined = None
        if refined:
            await ws.send_json(refined)
        log.info("deepgram refine %.1fs speakers=%s", time.perf_counter() - t, refined["speakers"] if refined else "-")
        await ws.send_json({"type": "done"})
        log.info(
            "deepgram session done audio=%.1fs wall=%.1fs %s",
            audio_bytes / frame_bytes / SAMPLE_RATE,
            time.perf_counter() - started,
            watch.summary(),
        )
    finally:
        _active -= 1
        if dump is not None:
            dump.close()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if dg is not None:
            await dg.close()


# ---------------------------------------------------------------- file


def transcribe_pcm(pcm16: bytes, language: str | None = None) -> list[dict]:
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
        "language": pick_language(language),
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
