"""Test logic chuyển kết quả Deepgram → message MeetScribe, không cần key (dùng message giả lập đúng định dạng).

Kiểm tra: 2 kênh (meeting/mic), tách 2 người trong cùng 1 đoạn final, câu vọng ở mic bị lọc,
chữ tạm, và câu thật ở mic được giữ lại.

Chạy: .venv/Scripts/python scripts/test_deepgram_bridge.py
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import deepgram_engine  # noqa: E402
import pipeline  # noqa: E402


def results(ch: int, is_final: bool, words: list[tuple[str, float, float, int]]) -> dict:
    return {
        "type": "Results",
        "channel_index": [ch, 2],
        "is_final": is_final,
        "channel": {
            "alternatives": [
                {
                    "transcript": " ".join(w for w, *_ in words),
                    "words": [{"word": w, "punctuated_word": w, "start": s, "end": e, "speaker": spk} for w, s, e, spk in words],
                }
            ]
        },
    }


pipeline.ECHO_HOLD_MS = 0  # test không phải chờ 1,5 s thật
deepgram_engine.ECHO_HOLD_MS = 0
state = deepgram_engine._State(["meeting", "mic"])
out = []
out += state.handle(results(0, False, [("Hôm", 0.0, 0.2, 0), ("nay", 0.2, 0.4, 0)]))
# Một đoạn final có 2 người nói nối nhau: phải tách thành 2 câu
out += state.handle(
    results(0, True, [("Hôm", 0.0, 0.2, 0), ("nay", 0.2, 0.4, 0), ("deploy", 0.4, 0.9, 0), ("Ok", 1.0, 1.2, 1), ("anh.", 1.2, 1.4, 1)])
)
# Mic thu lại tiếng loa (trùng câu của người 1) → phải bị lọc
out += state.handle(results(1, True, [("Hôm", 0.1, 0.3, 0), ("nay", 0.3, 0.5, 0), ("deploy", 0.5, 1.0, 0)]))
# Mic: câu thật của mình → phải giữ, nhãn "me"
out += state.handle(results(1, True, [("Để", 3.0, 3.2, 0), ("em", 3.2, 3.4, 0), ("check", 3.4, 3.8, 0)]))
time.sleep(0.01)
out += state.release(force=True)

finals = [m for m in out if m["type"] == "final"]
for m in finals:
    print(f"[{m['startMs'] / 1000:4.1f}s] {m['channel']:7} speaker={m['speaker']:3} {m['text']}")
partials = [m for m in out if m["type"] == "partial" and m["text"]]
print(f"partial đầu tiên: {partials[0]['text']!r}")

assert [(m["speaker"], m["text"]) for m in finals] == [
    ("1", "Hôm nay deploy"),
    ("2", "Ok anh."),
    ("me", "Để em check"),
], "kết quả không đúng"
print("OK: tách 2 người trong 1 đoạn, lọc câu vọng, giữ câu của mình")
