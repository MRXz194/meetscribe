"""Thử câu tiếng Việt chen thuật ngữ tiếng Anh (kiểu nói trong team IT).

Audio tạo bằng Edge TTS (giọng tiếng Việt đọc cả từ tiếng Anh) nên chỉ là dữ liệu giả lập:
người thật phát âm từ tiếng Anh đa dạng hơn. So 2 model ASR, có và không có hotwords.

Chạy: .venv/Scripts/python scripts/test_codeswitch.py
"""

import asyncio
import re
import sys
import tempfile
from pathlib import Path

import numpy as np
import sentencepiece as spm
import sherpa_onnx
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
OUT = ROOT / "eval" / "codeswitch"

SENTENCES = [
    ("Hôm nay team mình review code rồi deploy lên server production nhé.", ["TEAM", "REVIEW", "CODE", "DEPLOY", "SERVER", "PRODUCTION"]),
    ("Deadline của task này là thứ sáu, anh Nam check lại API giúp em.", ["DEADLINE", "TASK", "CHECK", "API"]),
    ("Bên frontend đang bị bug ở màn hình login, cần fix trước sprint planning.", ["FRONTEND", "BUG", "LOGIN", "FIX", "SPRINT", "PLANNING"]),
    ("Mình dùng Docker với Kubernetes, pipeline chạy trên GitHub Actions.", ["DOCKER", "KUBERNETES", "PIPELINE", "GITHUB", "ACTIONS"]),
    ("Meeting này chốt KPI quý bốn và roadmap sản phẩm.", ["MEETING", "KPI", "ROADMAP"]),
    ("Cuộc họp hôm nay bàn về kế hoạch tuyển dụng nhân sự cho quý tới.", []),  # câu thuần Việt để đối chứng
]
VOICES = ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]

ASR = {
    "vi-30M": ("sherpa-onnx-zipformer-vi-30M-int8-2026-02-09", "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"),
    "vi-70k": (
        "sherpa-onnx-zipformer-vi-int8-2025-04-20",
        "encoder-epoch-12-avg-8.int8.onnx",
        "decoder-epoch-12-avg-8.onnx",
        "joiner-epoch-12-avg-8.int8.onnx",
    ),
}


async def synthesize():
    import edge_tts

    OUT.mkdir(parents=True, exist_ok=True)
    files = []
    for i, (text, _) in enumerate(SENTENCES):
        for voice in VOICES:
            path = OUT / f"{i}-{voice.split('-')[2]}.mp3"
            if not path.exists():
                await edge_tts.Communicate(text, voice).save(str(path))
            files.append((i, voice, path))
    return files


def load_16k(path: Path) -> np.ndarray:
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:  # nội suy đơn giản, đủ cho thử nghiệm
        t = np.arange(0, len(mono) / sr, 1 / 16000)
        mono = np.interp(t, np.arange(len(mono)) / sr, mono).astype(np.float32)
    return mono


def recognizer(name: str, hotwords: Path | None, vocab: Path | None):
    d, enc, dec, joi = ASR[name]
    d = MODELS / d
    kw = dict(decoding_method="greedy_search")
    if hotwords:
        kw = dict(
            decoding_method="modified_beam_search",
            hotwords_file=str(hotwords),
            hotwords_score=2.0,
            modeling_unit="bpe",
            bpe_vocab=str(vocab),
        )
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / enc), decoder=str(d / dec), joiner=str(d / joi), tokens=str(d / "tokens.txt"), num_threads=4, **kw
    )


def export_vocab(model_dir: Path, tmp: Path) -> Path:
    sp = spm.SentencePieceProcessor(model_file=str(model_dir / "bpe.model"))
    path = tmp / f"{model_dir.name}.vocab"
    path.write_text("".join(f"{sp.id_to_piece(i)}\t{sp.get_score(i)}\n" for i in range(sp.get_piece_size())), encoding="utf-8")
    return path


def main():
    files = asyncio.run(synthesize())
    terms = sorted({t for _, ts in SENTENCES for t in ts})
    tmp = Path(tempfile.mkdtemp())
    hot = tmp / "hotwords.txt"
    hot.write_text("".join(f"{t}\n" for t in terms), encoding="utf-8")

    for name in ASR:
        vocab = export_vocab(MODELS / ASR[name][0], tmp)
        for label, hw in (("không hotwords", None), ("có hotwords", hot)):
            rec = recognizer(name, hw, vocab)
            hit = total = 0
            print(f"\n===== {name} | {label} =====")
            for i, voice, path in files:
                s = rec.create_stream()
                s.accept_waveform(16000, load_16k(path))
                rec.decode_stream(s)
                text = s.result.text
                words = set(re.findall(r"[A-ZÀ-Ỹ0-9]+", text.upper()))
                expect = SENTENCES[i][1]
                got = [t for t in expect if t in words]
                hit += len(got)
                total += len(expect)
                tag = f"{len(got)}/{len(expect)}" if expect else "đối chứng"
                print(f"[{i}-{voice.split('-')[2]:9}] {tag:9} {text}")
            print(f"--> nhận đúng {hit}/{total} thuật ngữ tiếng Anh ({100 * hit / total:.0f}%)")


if __name__ == "__main__":
    sys.exit(main())
