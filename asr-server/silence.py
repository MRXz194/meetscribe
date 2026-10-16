"""Phát hiện kênh audio im lặng hoàn toàn: nguyên nhân phổ biến nhất khiến "không thấy transcript" là quên bật
"Chia sẻ âm thanh tab" (kênh meeting) hoặc micro bị tắt. Dùng chung cho engine local và deepgram."""

from __future__ import annotations

import time

import numpy as np

# Đỉnh biên độ (thang int16) dưới mức này suốt WAIT_SEC đầu coi là chưa có tiếng (~ -44 dBFS)
SILENT_PEAK = 200
WAIT_SEC = 8.0


class SilenceWatch:
    def __init__(self, channels: list[str]) -> None:
        self.channels = channels
        self.peak = {c: 0 for c in channels}
        self.warned: set[str] = set()
        self.started = time.monotonic()

    def feed(self, pcm16: bytes) -> None:
        n = len(self.channels)
        samples = np.frombuffer(pcm16[: len(pcm16) // (2 * n) * (2 * n)], dtype=np.int16).reshape(-1, n)
        if len(samples):
            peaks = np.abs(samples.astype(np.int32)).max(axis=0)
            for c, p in zip(self.channels, peaks):
                self.peak[c] = max(self.peak[c], int(p))

    def poll(self) -> list[dict]:
        """Message status cần gửi cho trình duyệt: silent:<kênh> khi mới phát hiện, audio_ok:<kênh> khi có tiếng trở lại."""
        if time.monotonic() - self.started < WAIT_SEC:
            return []
        out = []
        for c in self.channels:
            silent = self.peak[c] < SILENT_PEAK
            if silent and c not in self.warned:
                self.warned.add(c)
                out.append({"type": "status", "message": f"silent:{c}"})
            elif not silent and c in self.warned:
                self.warned.discard(c)
                out.append({"type": "status", "message": f"audio_ok:{c}"})
        return out

    def summary(self) -> str:
        return " ".join(f"peak[{c}]={p}" for c, p in self.peak.items())
