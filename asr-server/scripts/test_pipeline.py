"""Test pipeline với 2 kênh giả lập: kênh meeting có 3 người nói, kênh mic có tiếng
của mình + 1 câu bị vọng lại từ loa. Kỳ vọng: 3 người khác nhau ở meeting, câu vọng bị lọc.

Chạy: .venv/Scripts/python.exe scripts/test_pipeline.py
"""

import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import SAMPLE_RATE, Session  # noqa: E402

WAVS = Path(__file__).resolve().parent.parent / "models"


def load(rel: str) -> np.ndarray:
    s, sr = sf.read(WAVS / rel, dtype="float32")
    assert sr == SAMPLE_RATE
    return s


def place(track: np.ndarray, clip: np.ndarray, at_sec: float, gain: float = 1.0) -> None:
    i = int(at_sec * SAMPLE_RATE)
    track[i : i + len(clip)] += clip * gain


a = "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09/test_wavs/"
b = "sherpa-onnx-zipformer-vi-int8-2025-04-20/test_wavs/"
total = 26 * SAMPLE_RATE
meeting = np.zeros(total, np.float32)
mic = np.zeros(total, np.float32)

# Người A nói 2 lần (cách xa nhau) để kiểm tra nhận lại đúng người cũ
place(meeting, load(a + "0.wav"), 0.5)
place(meeting, load(a + "1.wav"), 5.5)
place(meeting, load(a + "2.wav"), 9.5)
place(meeting, np.concatenate([load(a + "0.wav")[:16000], load(a + "0.wav")]), 13.0)
# Mic: câu của mình + tiếng loa vọng lại câu ở giây 5.5 (nhỏ hơn)
place(mic, load(b + "1.wav") * 0 + load(a + "1.wav"), 5.5, gain=0.4)
place(mic, load(b + "2.wav"), 20.0)

session = Session(["meeting", "mic"])
pcm = (np.stack([meeting, mic], axis=1).clip(-1, 1) * 32767).astype(np.int16).tobytes()
frame = int(0.1 * SAMPLE_RATE) * 2 * 2  # 100 ms stereo
t = time.perf_counter()
msgs = []
for off in range(0, len(pcm), frame):
    msgs += session.feed(pcm[off : off + frame])
msgs += session.finish()
elapsed = time.perf_counter() - t

t2 = time.perf_counter()
refined = session.refine()
refine_sec = time.perf_counter() - t2

partials = sum(1 for m in msgs if m["type"] == "partial" and m["text"])
for m in msgs:
    if m["type"] == "final":
        print(f"[{m['startMs'] / 1000:5.1f}s] {m['channel']:7} speaker={m['speaker']:3} {m['text']}")
print(f"\n{partials} partial updates | xử lý {total / SAMPLE_RATE:.0f}s audio trong {elapsed:.2f}s (RTF {elapsed / (total / SAMPLE_RATE):.3f})")
if refined:
    print(f"\nBản cuối sau diarization offline ({refine_sec:.2f}s, {refined['speakers']} người ở kênh meeting):")
    for m in refined["segments"]:
        print(f"[{m['startMs'] / 1000:5.1f}s] {m['channel']:7} speaker={m['speaker']:3} {m['text']}")
else:
    print("\nKhông chạy được diarization offline (thiếu model hoặc audio quá ngắn)")
