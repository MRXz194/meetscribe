"""Tải các model ONNX chính thức từ GitHub releases của k2-fsa/sherpa-onnx (~135 MB).

Chạy: python scripts/download_models.py
"""

import tarfile
import urllib.request
from pathlib import Path

MODELS = Path(__file__).resolve().parent.parent / "models"
BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

ARCHIVES = [
    # ASR tiếng Việt 30M tham số, ~6.000 giờ dữ liệu (hynt/Zipformer-30M-RNNT-6000h), mặc định
    "asr-models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2",
    # ASR tiếng Việt lớn hơn, ~70.000 giờ dữ liệu: đặt ASR_MODEL=sherpa-onnx-zipformer-vi-int8-2025-04-20
    "asr-models/sherpa-onnx-zipformer-vi-int8-2025-04-20.tar.bz2",
    # pyannote segmentation 3.0 (MIT) cho diarization offline khi kết thúc cuộc họp
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
]
FILES = {
    "silero_vad.onnx": "asr-models/silero_vad.onnx",
    # Speaker embedding CAM++ (3D-Speaker), vector 192 chiều
    "campplus.onnx": "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
}


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    for rel in ARCHIVES:
        name = rel.split("/")[-1].removesuffix(".tar.bz2")
        if (MODELS / name).exists():
            print(f"✓ {name}")
            continue
        archive = MODELS / f"{name}.tar.bz2"
        print(f"↓ {name}")
        urllib.request.urlretrieve(f"{BASE}/{rel}", archive)
        with tarfile.open(archive) as tar:
            tar.extractall(MODELS, filter="data")
        archive.unlink()
    for name, rel in FILES.items():
        if (MODELS / name).exists():
            print(f"✓ {name}")
            continue
        print(f"↓ {name}")
        urllib.request.urlretrieve(f"{BASE}/{rel}", MODELS / name)


if __name__ == "__main__":
    main()
