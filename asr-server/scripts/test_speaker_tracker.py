"""Đoạn ngắn mở đầu ("ừ") không được chiếm nhãn người nói 1 làm người thật bị đẩy sang 2."""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import SpeakerTracker  # noqa: E402

rng = np.random.default_rng(1)
a, b = (v / np.linalg.norm(v) for v in rng.normal(size=(2, 192)).astype(np.float32))
t = SpeakerTracker()
assert t.assign(None) == "1"  # "ừ" mở đầu
assert t.assign(a) == "1", "người thật đầu tiên phải là 1"
assert t.assign(b) == "2"
assert t.assign(a) == "1"
assert len(t.sums) == 2
print("OK: không còn người nói ma ở đầu cuộc họp")
