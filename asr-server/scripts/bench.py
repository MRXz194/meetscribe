"""So sánh nhanh các model ASR tiếng Việt của sherpa-onnx trên CPU: tốc độ (RTF) và text ra.

Chạy: .venv/Scripts/python.exe scripts/bench.py
"""

import time
from pathlib import Path

import sherpa_onnx
import soundfile as sf

MODELS = Path(__file__).resolve().parent.parent / "models"

CANDIDATES = {
    "vi-30M (6k giờ)": dict(
        dir="sherpa-onnx-zipformer-vi-30M-int8-2026-02-09",
        encoder="encoder.int8.onnx",
        decoder="decoder.onnx",
        joiner="joiner.int8.onnx",
    ),
    "vi-2025-04 (70k giờ)": dict(
        dir="sherpa-onnx-zipformer-vi-int8-2025-04-20",
        encoder="encoder-epoch-12-avg-8.int8.onnx",
        decoder="decoder-epoch-12-avg-8.onnx",
        joiner="joiner-epoch-12-avg-8.int8.onnx",
    ),
}


def load(cfg):
    d = MODELS / cfg["dir"]
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / cfg["encoder"]),
        decoder=str(d / cfg["decoder"]),
        joiner=str(d / cfg["joiner"]),
        tokens=str(d / "tokens.txt"),
        num_threads=4,
        decoding_method="greedy_search",
    )


def main():
    wavs = sorted((MODELS / CANDIDATES["vi-30M (6k giờ)"]["dir"] / "test_wavs").glob("*.wav"))
    for name, cfg in CANDIDATES.items():
        t0 = time.perf_counter()
        rec = load(cfg)
        print(f"\n=== {name} | load {time.perf_counter() - t0:.2f}s")
        total_audio = total_proc = 0.0
        for wav in wavs:
            samples, sr = sf.read(wav, dtype="float32")
            stream = rec.create_stream()
            stream.accept_waveform(sr, samples)
            t = time.perf_counter()
            rec.decode_stream(stream)
            dt = time.perf_counter() - t
            dur = len(samples) / sr
            total_audio += dur
            total_proc += dt
            print(f"  {wav.name} ({dur:.1f}s, {dt * 1000:.0f}ms): {stream.result.text}")
        print(f"  RTF = {total_proc / total_audio:.3f}  (càng nhỏ càng nhanh; 0.05 = nhanh gấp 20 lần thời gian thực)")


if __name__ == "__main__":
    main()
