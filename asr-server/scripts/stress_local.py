"""Stress engine Local: họp dài dày tiếng nói, 2 kênh. Đo RTF, độ trễ xử lý mỗi frame 100 ms, RAM và thời gian refine.

Chạy: .venv/Scripts/python scripts/stress_local.py [số phút, mặc định 20]
"""

import sys
import time
from pathlib import Path

import numpy as np
import psutil
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import SAMPLE_RATE, Session  # noqa: E402

minutes = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 20
M = Path(__file__).resolve().parent.parent / "models"
clips = [sf.read(M / d / "test_wavs" / f"{i}.wav", dtype="float32")[0]
         for d in ("sherpa-onnx-zipformer-vi-30M-int8-2026-02-09", "sherpa-onnx-zipformer-vi-int8-2025-04-20")
         for i in range(3)]
total = int(minutes * 60 * SAMPLE_RATE)
meeting = np.zeros(total, np.float32)
mic = np.zeros(total, np.float32)
rng = np.random.default_rng(0)
for track, offset in ((meeting, 0.0), (mic, 2.5)):
    t = offset
    while t * SAMPLE_RATE < total - 20 * SAMPLE_RATE:
        c = clips[rng.integers(len(clips))]
        i = int(t * SAMPLE_RATE)
        track[i : i + len(c)] += c
        t += len(c) / SAMPLE_RATE + rng.uniform(0.3, 2.5)

proc = psutil.Process()
s = Session(["meeting", "mic"])
frame = SAMPLE_RATE // 10
lat, nfinal = [], 0
base_rss = proc.memory_info().rss / 1e6
t0 = time.perf_counter()
for off in range(0, total - frame, frame):
    pcm = (np.stack([meeting[off : off + frame], mic[off : off + frame]], axis=1) * 32767).astype(np.int16).tobytes()
    t = time.perf_counter()
    outs = s.feed(pcm)
    lat.append(time.perf_counter() - t)
    nfinal += sum(1 for o in outs if o["type"] == "final")
    if (off // frame) % 3000 == 2999:
        print(f"  {(off + frame) / SAMPLE_RATE / 60:.0f} phút: RAM {proc.memory_info().rss / 1e6:.0f} MB", flush=True)
wall = time.perf_counter() - t0
lat = np.array(lat)
print(f"audio {minutes:.0f} phút, {nfinal} câu final, xử lý {wall:.0f}s (RTF {wall / (total / SAMPLE_RATE):.3f})")
print(f"độ trễ mỗi frame 100ms: p50={np.percentile(lat, 50) * 1000:.0f}ms p99={np.percentile(lat, 99) * 1000:.0f}ms max={lat.max() * 1000:.0f}ms (>100ms nghĩa là tụt lại sau realtime)")
print(f"RAM: {base_rss:.0f} MB -> {proc.memory_info().rss / 1e6:.0f} MB")
t = time.perf_counter()
s.finish()
print(f"finish {time.perf_counter() - t:.1f}s")
if "--no-refine" in sys.argv:
    raise SystemExit
t = time.perf_counter()
r = s.refine()
print(f"refine {time.perf_counter() - t:.1f}s, {r['speakers'] if r else '-'} người, RAM {proc.memory_info().rss / 1e6:.0f} MB, peak {proc.memory_info().peak_wset / 1e6:.0f} MB")
