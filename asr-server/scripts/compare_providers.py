"""So 3 engine trên CÙNG một file ghi âm cuộc họp: local (sherpa-onnx), Deepgram, Gemini 3.5 Transcribe.

Cả 3 nhận cùng một bản audio đã chuẩn hoá (16 kHz mono WAV) để so công bằng.

Chạy:
    .venv/Scripts/python scripts/compare_providers.py duong/dan/ghi-am.mp3 --speakers 3
    .venv/Scripts/python scripts/compare_providers.py ghi-am.mp3 --speakers 3 --ref dap-an.txt
    .venv/Scripts/python scripts/compare_providers.py ghi-am.mp3 --only local,gemini

Tuỳ chọn:
    --speakers N   số người nói thật trong file (để so số người mỗi engine đếm được)
    --ref FILE     transcript chuẩn do bạn tự gõ (chữ thường, không cần nhãn người nói) → tính WER/CER
    --only ...     chỉ chạy một số engine: local, deepgram, gemini

Key đọc từ biến môi trường hoặc ../meetscribe/.env.local:
    DEEPGRAM_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY

LƯU Ý RIÊNG TƯ: engine deepgram và gemini gửi audio ra server của Deepgram và Google.
Gói miễn phí của Gemini có thể dùng dữ liệu để cải thiện sản phẩm. Hãy xin phép những người
có giọng trong file trước khi gửi. Engine local không gửi gì ra ngoài.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

import av
import httpx
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ENV_FILE = ROOT.parent / "meetscribe" / ".env.local"
OUT = ROOT / "eval" / "compare"
GEMINI_MAX_SEC = 30 * 60  # giới hạn khi bật tách người nói (theo docs Gemini 3.5 Transcribe)


# ---------------------------------------------------------------- tiện ích


def load_env() -> None:
    """Nạp key từ meetscribe/.env.local nếu biến môi trường chưa có."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$", line)
        if m and m.group(2) and not os.environ.get(m.group(1)):
            os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


def decode_16k_mono(path: Path) -> np.ndarray:
    """Giải mã mọi định dạng (mp3, m4a, ogg, webm, mp4…) về float32 16 kHz mono bằng PyAV."""
    container = av.open(str(path))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []
    for frame in container.decode(audio=0):
        for out in resampler.resample(frame):
            chunks.append(out.to_ndarray().reshape(-1))
    for out in resampler.resample(None):
        chunks.append(out.to_ndarray().reshape(-1))
    container.close()
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def write_wav(path: Path, samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    return pcm.tobytes()


def merge_words(words: list[dict]) -> list[dict]:
    """Gộp các từ liên tiếp cùng người nói thành đoạn."""
    segs: list[dict] = []
    for w in words:
        if segs and segs[-1]["speaker"] == w["speaker"]:
            segs[-1]["text"] += " " + w["text"]
            segs[-1]["end"] = w["end"]
        else:
            segs.append(dict(w))
    return segs


def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def clock(sec: float) -> str:
    return f"{int(sec // 60):02d}:{int(sec % 60):02d}"


# ---------------------------------------------------------------- 3 engine


def run_local(pcm16: bytes) -> list[dict]:
    from pipeline import transcribe_pcm  # nạp model sherpa-onnx khi cần

    return [
        {"speaker": s["speaker"], "start": s["startMs"] / 1000, "end": s["endMs"] / 1000, "text": s["text"]}
        for s in transcribe_pcm(pcm16)
    ]


def run_deepgram(wav_path: Path, model: str) -> list[dict]:
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise RuntimeError("Thiếu DEEPGRAM_API_KEY")
    params = {
        "model": model,
        "language": "vi",
        "diarize": "true",
        "punctuate": "true",
        "smart_format": "true",
        "utterances": "true",
    }
    res = httpx.post(
        "https://api.deepgram.com/v1/listen",
        params=params,
        headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
        content=wav_path.read_bytes(),
        timeout=600,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Deepgram {res.status_code}: {res.text[:300]}")
    body = res.json()
    utts = body.get("results", {}).get("utterances") or []
    if utts:
        return merge_words(
            [{"speaker": str(u.get("speaker", 0) + 1), "start": u["start"], "end": u["end"], "text": u["transcript"]} for u in utts]
        )
    words = body["results"]["channels"][0]["alternatives"][0].get("words", [])
    return merge_words(
        [
            {"speaker": str(w.get("speaker", 0) + 1), "start": w["start"], "end": w["end"], "text": w.get("punctuated_word", w["word"])}
            for w in words
        ]
    )


def _walk(obj, found: list[dict]) -> None:
    """Tìm mọi annotation word_info trong response (cấu trúc lồng nhiều tầng)."""
    if isinstance(obj, dict):
        if obj.get("type") == "word_info" and "text" in obj:
            found.append(obj)
        for v in obj.values():
            _walk(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _walk(v, found)


def _offset(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value).rstrip("s") or 0)


def run_gemini(wav_path: Path, duration: float) -> list[dict]:
    key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("Thiếu GOOGLE_GENERATIVE_AI_API_KEY")
    if duration > GEMINI_MAX_SEC:
        raise RuntimeError(f"File {duration / 60:.0f} phút, Gemini chỉ tách người nói tối đa 30 phút. Cắt ngắn file.")
    from google import genai

    client = genai.Client(api_key=key)
    uploaded = client.files.upload(file=str(wav_path))
    try:
        interaction = client.interactions.create(
            model="gemini-3.5-transcribe",
            input=[{"type": "audio", "uri": uploaded.uri, "mime_type": "audio/wav"}],
            generation_config={
                "transcription_config": {
                    "language_codes": ["vi-VN", "en-US"],
                    "mode": {"type": "verbatim", "diarization_mode": "speaker", "timestamp_granularities": ["word"]},
                }
            },
        )
        data = interaction.model_dump() if hasattr(interaction, "model_dump") else dict(interaction)
        # Request dài có thể trả về khi chưa xong → hỏi lại tới khi hoàn tất
        deadline = time.time() + 900
        while data.get("status") not in (None, "completed", "failed", "cancelled") and time.time() < deadline:
            time.sleep(3)
            data = client.interactions.get(id=data["id"]).model_dump()
        if data.get("status") == "failed":
            raise RuntimeError(f"Gemini báo lỗi: {json.dumps(data)[:300]}")
        words: list[dict] = []
        _walk(data, words)
        if not words:
            text = getattr(interaction, "output_text", "") or ""
            return [{"speaker": "?", "start": 0.0, "end": duration, "text": text}]
        return merge_words(
            [
                {
                    "speaker": str(w.get("speaker", "?")).replace("spk_", ""),
                    "start": _offset(w.get("start_offset", 0)),
                    "end": _offset(w.get("end_offset", 0)),
                    "text": w["text"],
                }
                for w in words
            ]
        )
    finally:
        try:
            client.files.delete(name=uploaded.name)
        except Exception:  # noqa: BLE001 - xoá file tạm không được thì thôi, Google tự xoá sau 48 giờ
            pass


# ---------------------------------------------------------------- báo cáo


def summarize(name: str, segs: list[dict], elapsed: float, duration: float, args, ref: str | None) -> dict:
    speakers = sorted({s["speaker"] for s in segs})
    row = {
        "engine": name,
        "speakers": len(speakers),
        "turns": len(segs),
        "seconds": round(elapsed, 1),
        "rtf": round(elapsed / max(duration, 1e-6), 3),
    }
    if args.speakers:
        row["speaker_error"] = len(speakers) - args.speakers
    if ref:
        import jiwer

        hyp = normalize(" ".join(s["text"] for s in segs))
        row["wer"] = round(100 * jiwer.wer(ref, hyp), 1)
        row["cer"] = round(100 * jiwer.cer(ref, hyp), 1)
    return row


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio", type=Path)
    p.add_argument("--speakers", type=int)
    p.add_argument("--ref", type=Path)
    p.add_argument("--only", default="local,deepgram,gemini")
    p.add_argument("--deepgram-model", default="nova-3")
    args = p.parse_args()

    load_env()
    if not args.audio.exists():
        print(f"Không thấy file {args.audio}")
        return 1

    out_dir = OUT / args.audio.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = decode_16k_mono(args.audio)
    duration = len(samples) / 16000
    wav_path = out_dir / "input-16k.wav"
    pcm16 = write_wav(wav_path, samples)
    ref = normalize(args.ref.read_text(encoding="utf-8")) if args.ref else None
    print(f"File: {args.audio.name} | {clock(duration)} | {len(samples)} mẫu 16 kHz")

    engines = {
        "local": lambda: run_local(pcm16),
        "deepgram": lambda: run_deepgram(wav_path, args.deepgram_model),
        "gemini": lambda: run_gemini(wav_path, duration),
    }
    rows, results = [], {}
    for name in [n.strip() for n in args.only.split(",") if n.strip()]:
        print(f"\n▶ {name} …", flush=True)
        t = time.perf_counter()
        try:
            segs = engines[name]()
        except Exception as err:  # noqa: BLE001 - 1 engine lỗi thì vẫn chạy tiếp engine khác
            print(f"  lỗi: {err}")
            rows.append({"engine": name, "error": str(err)[:200]})
            continue
        elapsed = time.perf_counter() - t
        results[name] = segs
        (out_dir / f"{name}.json").write_text(json.dumps(segs, ensure_ascii=False, indent=2), encoding="utf-8")
        row = summarize(name, segs, elapsed, duration, args, ref)
        rows.append(row)
        print(f"  {row}")

    # Bảng tóm tắt + transcript từng engine, để đọc và so bằng mắt
    cols = ["engine", "speakers", "speaker_error", "turns", "wer", "cer", "seconds", "rtf", "error"]
    cols = [c for c in cols if any(c in r for r in rows)]
    lines = [
        f"# So sánh engine: {args.audio.name}",
        "",
        f"- Độ dài: {clock(duration)}" + (f" · số người thật: {args.speakers}" if args.speakers else ""),
        "- speakers = số người engine đếm được; speaker_error = đếm thừa (+) hoặc thiếu (−)",
        "- turns = số lượt nói sau khi gộp; wer/cer chỉ có khi truyền --ref (%, càng thấp càng tốt)",
        "",
        "| " + " | ".join(cols) + " |",
        "| " + " | ".join("---" for _ in cols) + " |",
    ]
    for r in rows:
        lines.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
    for name, segs in results.items():
        lines += ["", f"## {name}", ""]
        lines += [f"- `{clock(s['start'])}` **Người {s['speaker']}**: {s['text']}" for s in segs]
    report = out_dir / "report.md"
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("\n" + "\n".join(lines[6 : 8 + len(rows)]))
    print(f"\nBáo cáo đầy đủ: {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
