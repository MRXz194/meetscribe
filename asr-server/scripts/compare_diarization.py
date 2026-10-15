"""So sánh 2 cách nhận ai nói trên cùng audio có nhiều người thật:

  A. OfflineSpeakerDiarization của sherpa-onnx (pyannote segmentation 3.0 + CAM++ + clustering,
     xem lại cả file) - dùng làm chuẩn tham chiếu
  B. SpeakerTracker tự viết trong pipeline.py (online, quyết định từng câu ngay khi nghe xong)

Chỉ số: số người đếm được, và độ khớp theo thời gian giữa B và A (sau khi ghép nhãn tối ưu).
Audio mẫu: các file test của sherpa-onnx (đa số tiếng Anh/Trung; embedding không phụ thuộc ngôn ngữ nhiều).

Chạy: .venv/Scripts/python scripts/compare_diarization.py [ngưỡng ...]
"""

import itertools
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import pipeline  # noqa: E402
from pipeline import MODELS, SAMPLE_RATE, MIN_EMBED_SEC, MIN_NEW_SPEAKER_SEC, SpeakerTracker, new_vad  # noqa: E402

DIAR = MODELS / "diar"
FILES = {
    "0-four-speakers-zh.wav": 4,
    "1-two-speakers-en.wav": 2,
    "2-two-speakers-en.wav": 2,
    "3-two-speakers-en.wav": 2,
}


def offline_diarization(samples: np.ndarray, num_clusters: int = -1):
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx")
            ),
            num_threads=4,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(MODELS / "campplus.onnx"), num_threads=4),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_clusters, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    t = time.perf_counter()
    result = sd.process(samples).sort_by_start_time()
    return [(s.start, s.end, s.speaker) for s in result], time.perf_counter() - t


def online_tracker(samples: np.ndarray, threshold: float):
    models = pipeline.Models.get()
    vad = new_vad()
    tracker = SpeakerTracker(threshold=threshold)
    w = 512
    segs = []

    def drain():
        while not vad.empty():
            seg = vad.front
            s = np.asarray(seg.samples, dtype=np.float32)
            start = seg.start / SAMPLE_RATE
            vad.pop()
            dur = len(s) / SAMPLE_RATE
            emb = models.embed(s) if dur >= MIN_EMBED_SEC else None
            spk = tracker.assign(emb, can_create=dur >= MIN_NEW_SPEAKER_SEC)
            segs.append((start, start + dur, int(spk) - 1))

    for off in range(0, len(samples) - w, w):
        vad.accept_waveform(samples[off : off + w])
        drain()
    vad.flush()
    drain()
    return segs


def to_frames(segs, total_sec, step=0.1):
    n = int(total_sec / step) + 1
    frames = np.full(n, -1, dtype=int)
    for a, b, spk in segs:
        frames[int(a / step) : int(b / step) + 1] = spk
    return frames


def agreement(ref, hyp):
    """% khung thời gian khớp nhãn, thử mọi cách ghép nhãn hyp→ref, lấy tốt nhất (chỉ tính khung cả hai đều có tiếng)."""
    both = (ref >= 0) & (hyp >= 0)
    if not both.any():
        return 0.0
    r_labels, h_labels = sorted(set(ref[both])), sorted(set(hyp[both]))
    best = 0.0
    k = min(len(r_labels), len(h_labels))
    for perm in itertools.permutations(r_labels, k):
        mapping = dict(zip(h_labels[:k], perm))
        hit = sum(1 for r, h in zip(ref[both], hyp[both]) if mapping.get(h) == r)
        best = max(best, hit / both.sum())
    return 100 * best


def main():
    thresholds = [float(x) for x in sys.argv[1:]] or [0.35, 0.45, 0.55]
    pipeline.Models.get()
    print(f"{'file':26} {'thật':>4} | {'offline: người / giây xử lý':28} | " + " | ".join(f"online θ={t}: người / khớp" for t in thresholds))
    for name, truth in FILES.items():
        samples, sr = sf.read(DIAR / name, dtype="float32")
        assert sr == SAMPLE_RATE
        total = len(samples) / sr
        off_segs, off_t = offline_diarization(samples, num_clusters=-1)
        ref_segs, _ = offline_diarization(samples, num_clusters=truth)
        off_n = len({s for _, _, s in off_segs})
        ref = to_frames(ref_segs, total)
        cols = []
        for th in thresholds:
            on = online_tracker(samples, th)
            n = len({s for _, _, s in on})
            cols.append(f"{n} / {agreement(ref, to_frames(on, total)):4.0f}%")
        print(f"{name:26} {truth:>4} | {off_n} người, {off_t:5.1f}s (audio {total:.0f}s)   | " + " | ".join(f"{c:21}" for c in cols))


if __name__ == "__main__":
    main()
