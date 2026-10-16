"""Pipeline speech-to-text tiếng Việt chạy hoàn toàn local trên CPU.

Luồng cho mỗi kênh audio (16 kHz mono):

    PCM ──► Silero VAD ──(đoạn có tiếng)──► Zipformer-vi (ASR) ──► text
                │                       └──► CAM++ (speaker embedding 192 chiều)
                └─(đang nói)──► decode tạm phần đang nghe = partial

Ai nói:
- Kênh "mic" luôn là "me" (tách theo kênh vật lý, không phải đoán).
- Kênh "meeting", lúc đang ghi: SpeakerTracker gom cụm online (để có nhãn ngay).
- Kênh "meeting", khi bấm Dừng: OfflineSpeakerDiarization có sẵn của sherpa-onnx
  (pyannote segmentation 3.0 + CAM++ + clustering) xem lại cả cuộc họp rồi gán lại nhãn.
- is_echo bỏ câu ở mic trùng với câu ở meeting (micro thu lại tiếng loa).
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16000
MODELS = Path(os.environ.get("MODELS_DIR", Path(__file__).parent / "models"))
ASR_MODEL_DIR = MODELS / os.environ.get("ASR_MODEL", "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09")

# Chọn từ vài file mẫu ngắn (khác người ~0.1-0.2, cùng người câu dài ~0.8), CHƯA kiểm chứng trên họp thật
SPEAKER_THRESHOLD = float(os.environ.get("SPEAKER_THRESHOLD", "0.45"))
SEGMENTATION_MODEL = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
# 0.5 (mặc định cũ) tách 1 người thành 4-5 người trên hội thoại 2 giọng; 0.7 ra đúng số người cả khi có tạp âm
# và vẫn ra đúng 3 người ở 3 giọng thật của test_pipeline. Vẫn chỉ kiểm trên dữ liệu nhỏ.
DIARIZATION_THRESHOLD = float(os.environ.get("DIARIZATION_THRESHOLD", "0.7"))
MIN_DIARIZATION_SEC = 3.0
# Diarization offline tốn ~7 giây CPU mỗi phút audio (đo trên họp giả lập 2 kênh): họp 2 giờ sẽ chờ ~15 phút sau khi
# bấm Dừng, quá thời gian chờ của trình duyệt. Họp dài hơn mức này thì bỏ bước đó, giữ nhãn live.
MAX_REFINE_SEC = float(os.environ.get("MAX_REFINE_MIN", "45")) * 60
# Đoạn quá ngắn thì embedding nhiễu (cùng người chỉ còn ~0.3-0.5) nên:
# - dưới MIN_EMBED_SEC: không so giọng, gán cho người vừa nói
# - dưới MIN_NEW_SPEAKER_SEC: được so với người cũ, nhưng không đủ bằng chứng để tạo người mới
MIN_EMBED_SEC = 0.8
# Câu đáp ngắn ("vâng", "dạ", "ok") rất hay gặp và gần như luôn là người KHÁC vừa nói. Gán cho người vừa nói là sai,
# nên đoạn từ SHORT_EMBED_SEC trở lên vẫn được so giọng, nhưng chỉ nhận khi vượt hẳn người đứng nhì (SHORT_MARGIN).
SHORT_EMBED_SEC = 0.4
SHORT_MARGIN = 0.15
MIN_NEW_SPEAKER_SEC = 1.2
PARTIAL_EVERY_SEC = 0.6
ECHO_HOLD_MS = 1500


# ---------------------------------------------------------------- models (nạp 1 lần)


class Models:
    """Các model ONNX dùng chung cho mọi phiên; decode được gọi từ thread pool."""

    _instance: "Models | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        d = ASR_MODEL_DIR
        encoder = next(d.glob("encoder*.onnx"))
        decoder = next(d.glob("decoder*.onnx"))
        joiner = next(d.glob("joiner*.onnx"))
        threads = int(os.environ.get("NUM_THREADS", "4"))
        self.asr = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(encoder),
            decoder=str(decoder),
            joiner=str(joiner),
            tokens=str(d / "tokens.txt"),
            num_threads=threads,
            decoding_method="greedy_search",
        )
        self.embedder = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(MODELS / "campplus.onnx"), num_threads=2
            )
        )
        # Diarization offline (dùng nguyên của sherpa-onnx); thiếu model thì bỏ qua bước này
        self.diarizer = None
        if SEGMENTATION_MODEL.exists():
            self.diarizer = sherpa_onnx.OfflineSpeakerDiarization(
                sherpa_onnx.OfflineSpeakerDiarizationConfig(
                    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                            model=str(SEGMENTATION_MODEL)
                        ),
                        num_threads=threads,
                    ),
                    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                        model=str(MODELS / "campplus.onnx"), num_threads=threads
                    ),
                    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=DIARIZATION_THRESHOLD),
                    min_duration_on=0.3,
                    min_duration_off=0.5,
                )
            )
        self._diarize_lock = threading.Lock()

    def diarize(self, samples: np.ndarray) -> list[tuple[int, int, int]]:
        """Trả về [(start_ms, end_ms, speaker_index)] cho cả đoạn audio."""
        if self.diarizer is None:
            return []
        with self._diarize_lock:
            result = self.diarizer.process(samples).sort_by_start_time()
        return [(int(s.start * 1000), int(s.end * 1000), s.speaker) for s in result]

    @classmethod
    def get(cls) -> "Models":
        with cls._lock:
            if cls._instance is None:
                cls._instance = Models()
            return cls._instance

    def transcribe(self, samples: np.ndarray) -> str:
        stream = self.asr.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        self.asr.decode_stream(stream)
        return normalize_text(stream.result.text)

    def embed(self, samples: np.ndarray) -> np.ndarray:
        stream = self.embedder.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        stream.input_finished()
        e = np.asarray(self.embedder.compute(stream), dtype=np.float32)
        return e / (np.linalg.norm(e) + 1e-9)


def new_vad() -> sherpa_onnx.VoiceActivityDetector:
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(MODELS / "silero_vad.onnx")
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_silence_duration = 0.4  # im lặng 0.4s thì chốt câu
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = 12  # nói liền quá 12s thì cắt để chữ không bị treo
    cfg.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)


def normalize_text(text: str) -> str:
    """Model trả CHỮ HOA không dấu câu → chữ thường, viết hoa đầu câu."""
    text = " ".join(text.split()).lower()
    return text[:1].upper() + text[1:] if text else text


# ---------------------------------------------------------------- ai đang nói


class SpeakerTracker:
    """Diarization online: mỗi người là 1 centroid (trung bình embedding đã chuẩn hoá).

    Đoạn mới → so cosine với mọi centroid:
      - giống nhất ≥ ngưỡng → cùng người, cập nhật centroid
      - không ai đủ giống + đoạn đủ dài → người mới
      - không ai đủ giống + đoạn ngắn → chưa đủ bằng chứng, gán người vừa nói
    Đoạn rất ngắn ("ừ", "ok") → không so, gán cho người vừa nói.
    """

    def __init__(self, threshold: float = SPEAKER_THRESHOLD, max_speakers: int = 12) -> None:
        self.threshold = threshold
        self.max_speakers = max_speakers
        self.sums: list[np.ndarray] = []
        self.counts: list[int] = []
        self.last: str | None = None
        # Người "1" tạo ra từ đoạn quá ngắn để lấy embedding (vd "ừ" mở đầu): chưa có giọng thật, nhận embedding thật đầu tiên
        self.placeholder = False

    def peek(self, embedding: np.ndarray, can_create: bool) -> str | None:
        """Đoán người đang nói mà không cập nhật gì: dùng cho chữ tạm. None = chưa đủ căn cứ."""
        if not self.sums or self.placeholder:
            return None
        centroids = np.stack([s / np.linalg.norm(s) for s in self.sums])
        sims = centroids @ embedding
        best = int(np.argmax(sims))
        if sims[best] >= self.threshold or len(self.sums) >= self.max_speakers:
            return str(best + 1)
        return str(len(self.sums) + 1) if can_create else None

    def assign_short(self, embedding: np.ndarray) -> str:
        """Đoạn rất ngắn: nhận người giống nhất nếu vượt rõ người nhì, không thì coi như người vừa nói. Không tạo người mới."""
        if self.sums and not self.placeholder:
            centroids = np.stack([s / np.linalg.norm(s) for s in self.sums])
            sims = centroids @ embedding
            order = np.argsort(sims)[::-1]
            best = int(order[0])
            second = float(sims[order[1]]) if len(order) > 1 else -1.0
            if sims[best] >= 0.35 and sims[best] - second >= SHORT_MARGIN:
                self.last = str(best + 1)
                return self.last
        return self.last or self.assign(None)

    def assign(self, embedding: np.ndarray | None, can_create: bool = True) -> str:
        if embedding is None:
            if self.last:
                return self.last
            self.placeholder = True
            return self._new(None)
        if self.placeholder:
            # Thay centroid giả bằng giọng thật, không để "ừ" đầu cuộc họp chiếm mất nhãn người nói 1
            self.placeholder = False
            self.sums[0] = embedding.copy()
            self.counts[0] = 1
            self.last = "1"
            return self.last
        if self.sums:
            centroids = np.stack([s / np.linalg.norm(s) for s in self.sums])
            sims = centroids @ embedding
            best = int(np.argmax(sims))
            if sims[best] >= self.threshold or len(self.sums) >= self.max_speakers:
                self.sums[best] += embedding
                self.counts[best] += 1
                self.last = str(best + 1)
                return self.last
            if not can_create:
                return self.last or str(best + 1)
        return self._new(embedding)

    def _new(self, embedding: np.ndarray | None) -> str:
        self.sums.append(embedding.copy() if embedding is not None else np.zeros(192, np.float32) + 1e-6)
        self.counts.append(1)
        self.last = str(len(self.sums))
        return self.last


# ---------------------------------------------------------------- 1 kênh audio


@dataclass
class Final:
    id: int
    channel: str
    speaker: str
    text: str
    start_ms: int
    end_ms: int

    def to_json(self) -> dict:
        return {
            "type": "final",
            "id": self.id,
            "channel": self.channel,
            "speaker": self.speaker,
            "text": self.text,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
        }


@dataclass
class Channel:
    name: str
    vad: sherpa_onnx.VoiceActivityDetector = field(default_factory=new_vad)
    buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    received: int = 0  # tổng số sample đã nhận
    next_partial_at: int = 0
    partial: str = ""
    partial_speaker: str | None = None  # đoán người đang nói cho chữ tạm (chỉ kênh meeting)


class Session:
    """Một cuộc họp đang ghi. Không thread-safe: mỗi WebSocket có 1 Session riêng."""

    def __init__(self, channels: list[str]) -> None:
        self.models = Models.get()
        self.channels = {name: Channel(name) for name in channels}
        self.speakers = SpeakerTracker()
        self.held: list[Final] = []  # chờ lọc echo trước khi phát
        self.recent_meeting: list[Final] = []
        self.emitted: list[Final] = []  # mọi câu đã phát, để gán lại nhãn khi kết thúc
        self.meeting_audio: list[np.ndarray] = []  # giữ lại audio kênh meeting (int16) cho bước offline
        self._next_id = 1
        self.echo_filter = "mic" in self.channels and len(self.channels) > 1

    # Nhận PCM16 (interleaved nếu nhiều kênh), trả về các message cần gửi client
    def feed(self, pcm16: bytes) -> list[dict]:
        names = list(self.channels)
        raw = np.frombuffer(pcm16, dtype=np.int16).reshape(-1, len(names))
        if "meeting" in self.channels:
            self.meeting_audio.append(raw[:, names.index("meeting")].copy())
        frames = raw.astype(np.float32) / 32768.0
        out: list[dict] = []
        for i, name in enumerate(names):
            out += self._feed_channel(self.channels[name], frames[:, i])
        out += self._release(force=False)
        return out

    def finish(self) -> list[dict]:
        out: list[dict] = []
        for ch in self.channels.values():
            ch.vad.flush()
            out += self._drain(ch)
            ch.partial = ""
        out += self._release(force=True)
        out += [{"type": "partial", "channel": name, "speaker": "", "text": ""} for name in self.channels]
        return out

    def _feed_channel(self, ch: Channel, samples: np.ndarray) -> list[dict]:
        ch.received += len(samples)
        ch.buffer = np.concatenate([ch.buffer, samples])
        window = 512
        n = len(ch.buffer) // window * window
        for off in range(0, n, window):
            ch.vad.accept_waveform(ch.buffer[off : off + window])
        ch.buffer = ch.buffer[n:]

        out = self._drain(ch)

        # Partial: decode phần đang nói dở, tối đa ~1.7 lần/giây để nhẹ CPU
        if ch.vad.is_speech_detected() and ch.received >= ch.next_partial_at:
            ch.next_partial_at = ch.received + int(PARTIAL_EVERY_SEC * SAMPLE_RATE)
            current = np.asarray(ch.vad.current_segment.samples, dtype=np.float32)
            if len(current) > SAMPLE_RATE * 0.4:
                ch.partial = self.models.transcribe(current)
                if ch.name != "mic" and len(current) >= SAMPLE_RATE * MIN_EMBED_SEC:
                    # Chữ tạm mang nhãn đoán từ giọng đang nói, không phải nhãn của người vừa nói xong
                    tail = current[-SAMPLE_RATE * 3 :]
                    ch.partial_speaker = self.speakers.peek(
                        self.models.embed(tail), can_create=len(current) >= SAMPLE_RATE * MIN_NEW_SPEAKER_SEC
                    )
                out.append(self._partial_msg(ch))
        return out

    def _drain(self, ch: Channel) -> list[dict]:
        out: list[dict] = []
        while not ch.vad.empty():
            seg = ch.vad.front
            samples = np.asarray(seg.samples, dtype=np.float32)
            start = seg.start
            ch.vad.pop()
            text = self.models.transcribe(samples)
            ch.partial = ""
            ch.partial_speaker = None
            if not text:
                continue
            if ch.name == "mic":
                speaker = "me"
            else:
                dur = len(samples) / SAMPLE_RATE
                if dur >= MIN_EMBED_SEC:
                    speaker = self.speakers.assign(self.models.embed(samples), can_create=dur >= MIN_NEW_SPEAKER_SEC)
                elif dur >= SHORT_EMBED_SEC:
                    speaker = self.speakers.assign_short(self.models.embed(samples))
                else:
                    speaker = self.speakers.assign(None)
            final = Final(
                id=self._next_id,
                channel=ch.name,
                speaker=speaker,
                text=text,
                start_ms=int(start * 1000 / SAMPLE_RATE),
                end_ms=int((start + len(samples)) * 1000 / SAMPLE_RATE),
            )
            self._next_id += 1
            self.held.append(final)
            out.append(self._partial_msg(ch))
        return out

    def _now_ms(self) -> int:
        return min(ch.received for ch in self.channels.values()) * 1000 // SAMPLE_RATE

    def _release(self, force: bool) -> list[dict]:
        """Phát các câu đã chờ đủ lâu, theo thứ tự thời gian, sau khi lọc echo."""
        # Chỉ câu ở mic phải chờ để đối chiếu với kênh meeting; câu ở meeting phát ngay (nếu cũng chờ thì
        # mỗi câu bị trễ thêm 1,5 s khi bật mic)
        hold = ECHO_HOLD_MS if self.echo_filter else 0
        now = self._now_ms()
        ready = [f for f in self.held if force or f.channel != "mic" or now - f.end_ms >= hold]
        if not ready:
            return []
        self.held = [f for f in self.held if f not in ready]
        ready.sort(key=lambda f: f.start_ms)
        out: list[dict] = []
        meeting_pool = self.recent_meeting + [f for f in ready + self.held if f.channel == "meeting"]
        for f in ready:
            if f.channel == "mic" and self.echo_filter and is_echo(f, meeting_pool):
                continue
            if f.channel == "meeting":
                self.recent_meeting.append(f)
            self.emitted.append(f)
            out.append(f.to_json())
        self.recent_meeting = [f for f in self.recent_meeting if now - f.end_ms < 15000]
        touched = {f.channel for f in ready}
        out += [self._partial_msg(self.channels[name]) for name in touched]
        return out

    def refine(self) -> dict | None:
        """Sau khi dừng: diarization offline trên cả kênh meeting, gán lại nhãn cho từng câu.

        Trả về None nếu không chạy được (thiếu model, audio quá ngắn/dài) → client giữ nhãn live.
        """
        turns = diarize_turns(self.models, self.meeting_audio)
        if not turns:
            return None
        segments, n = label_by_turns(self.emitted, turns)
        return {"type": "final_transcript", "segments": segments, "speakers": n}

    def _partial_msg(self, ch: Channel) -> dict:
        # Câu đã chốt nhưng còn chờ lọc echo vẫn hiện ở dạng chữ xám để không bị "khoảng trống"
        pending = [f.text for f in self.held if f.channel == ch.name]
        text = " ".join(pending + ([ch.partial] if ch.partial else []))
        speaker = "me" if ch.name == "mic" else (ch.partial_speaker or self.speakers.last or "1")
        return {"type": "partial", "channel": ch.name, "speaker": speaker, "text": text}


def diarize_turns(models: Models, meeting_audio: list[np.ndarray]) -> list[tuple[int, int, int]] | None:
    """Diarization offline trên toàn bộ kênh meeting (int16 theo từng khối). None nếu quá ngắn/dài hoặc thiếu model."""
    if not meeting_audio:
        return None
    total = sum(len(a) for a in meeting_audio)
    if total < MIN_DIARIZATION_SEC * SAMPLE_RATE or total > MAX_REFINE_SEC * SAMPLE_RATE:
        return None
    audio = np.concatenate(meeting_audio).astype(np.float32) / 32768.0
    return models.diarize(audio) or None


def label_by_turns(items: list[Final], turns: list[tuple[int, int, int]]) -> tuple[list[dict], int]:
    """Gán lại người nói cho từng mục ở kênh meeting theo lượt nói của diarization offline.

    Mỗi mục nhận người nói chiếm nhiều thời gian nhất trong khoảng của nó (không chồng thì lấy lượt gần nhất).
    Nhãn đánh số lại theo thứ tự xuất hiện. Mục ở mic giữ nguyên "me".
    """

    def best_speaker(f: Final) -> int:
        overlap: dict[int, int] = {}
        for start, end, spk in turns:
            o = min(end, f.end_ms) - max(start, f.start_ms)
            if o > 0:
                overlap[spk] = overlap.get(spk, 0) + o
        if overlap:
            return max(overlap, key=lambda s: overlap[s])
        return min(turns, key=lambda t: min(abs(t[0] - f.end_ms), abs(t[1] - f.start_ms)))[2]

    order: dict[int, str] = {}
    segments = []
    for f in sorted(items, key=lambda f: f.start_ms):
        speaker = f.speaker
        if f.channel == "meeting":
            speaker = order.setdefault(best_speaker(f), str(len(order) + 1))
        segments.append({**f.to_json(), "speaker": speaker})
    return segments, len(order)


def is_echo(mic: Final, meeting: list[Final]) -> bool:
    """Câu ở mic trùng câu ở meeting trong cùng khoảng thời gian → micro thu lại tiếng loa."""
    for m in meeting:
        overlap = min(mic.end_ms, m.end_ms) - max(mic.start_ms, m.start_ms)
        if overlap < -1000:
            continue
        if SequenceMatcher(None, mic.text.lower(), m.text.lower()).ratio() >= 0.6:
            return True
    return False


def transcribe_pcm(pcm16: bytes) -> list[dict]:
    """Xử lý cả file (PCM16 mono 16 kHz): cùng pipeline realtime, rồi diarization offline cho nhãn cuối."""
    session = Session(["meeting"])
    chunk = SAMPLE_RATE * 2 * 10  # 10 giây mỗi lần
    messages: list[dict] = []
    for off in range(0, len(pcm16), chunk):
        messages += session.feed(pcm16[off : off + chunk])
    messages += session.finish()
    refined = session.refine()
    if refined:
        return refined["segments"]
    return [m for m in messages if m["type"] == "final"]
