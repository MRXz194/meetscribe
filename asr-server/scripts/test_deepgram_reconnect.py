"""Test rớt kết nối Deepgram giữa phiên, không cần key: dựng Deepgram giả ngay trên máy.

Deepgram giả đóng đột ngột kết nối đầu sau vài frame. Kiểm tra asr-server: nối lại, gửi bù audio,
cộng bù thời gian, không gộp nhầm nhãn người nói, vẫn kết thúc bằng "done"; và Origin lạ bị từ chối.

Chạy: .venv/Scripts/python scripts/test_deepgram_reconnect.py
"""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

os.environ["DEEPGRAM_API_KEY"] = "fake"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from websockets.asyncio.server import serve  # noqa: E402

PORT = 8765
os.environ["DEEPGRAM_WS_URL"] = f"ws://127.0.0.1:{PORT}/v1/listen"

import deepgram_engine  # noqa: E402

deepgram_engine.RECONNECT_DELAYS = [0.05, 0.1]

FRAME = b"\x00\x01" * 1600  # 100 ms, 1 kênh
connections: list[dict] = []


def final(start: float, end: float, spk: int) -> str:
    return json.dumps(
        {
            "type": "Results",
            "channel_index": [0, 1],
            "is_final": True,
            "channel": {
                "alternatives": [
                    {
                        "transcript": "xin chào",
                        "words": [{"word": "xin", "punctuated_word": "xin", "start": start, "end": end, "speaker": spk}],
                    }
                ]
            },
        }
    )


async def fake_deepgram(ws):
    info = {"frames": 0, "close_stream": False}
    connections.append(info)
    first = len(connections) == 1
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                info["frames"] += 1
                if first and info["frames"] == 3:
                    await ws.send(final(0.1, 0.3, 0))
                    await ws.close(code=1011)  # mạng rớt giữa chừng
                    return
            elif json.loads(msg).get("type") == "CloseStream":
                info["close_stream"] = True
                await ws.send(final(0.0, 0.2, 0))  # giờ của phiên mới bắt đầu lại từ 0
                await ws.close()
                return
    except Exception:  # noqa: BLE001
        pass


def run_fake():
    async def main():
        async with serve(fake_deepgram, "127.0.0.1", PORT):
            await asyncio.Future()

    asyncio.run(main())


threading.Thread(target=run_fake, daemon=True).start()

import time  # noqa: E402

time.sleep(0.5)

from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import app as asr_app  # noqa: E402

with TestClient(asr_app.app) as client:
    # Origin lạ (trang web bất kỳ) phải bị từ chối
    try:
        with client.websocket_connect("/ws", headers={"origin": "http://evil.example"}) as bad:
            bad.send_json({"type": "start", "sampleRate": 16000, "channels": ["meeting"], "engine": "deepgram"})
            bad.receive_json()
        raise SystemExit("FAIL: origin lạ vẫn được nhận")
    except WebSocketDisconnect:
        print("OK: origin lạ bị từ chối")

    msgs = []
    with client.websocket_connect("/ws", headers={"origin": "http://localhost:3000"}) as ws:
        ws.send_json({"type": "start", "sampleRate": 16000, "channels": ["meeting"], "engine": "deepgram"})
        assert ws.receive_json()["type"] == "ready"
        for _ in range(30):
            ws.send_bytes(FRAME)
            time.sleep(0.02)
        ws.send_json({"type": "stop"})
        while True:
            m = ws.receive_json()
            msgs.append(m)
            if m["type"] in ("done", "error"):
                break

finals = [m for m in msgs if m["type"] == "final"]
print([(m["speaker"], m["startMs"]) for m in finals])
assert msgs[-1]["type"] == "done", msgs[-1]
assert any(m.get("message") == "reconnecting" for m in msgs if m["type"] == "status"), "không báo đang nối lại"
assert len(connections) == 2, f"số kết nối {len(connections)}"
assert connections[1]["close_stream"], "chưa gửi CloseStream ở kết nối mới"
assert connections[1]["frames"] > 0, "không gửi bù audio sang kết nối mới"
assert [m["speaker"] for m in finals] == ["1", "2"], "nhãn người nói bị gộp nhầm sau khi nối lại"
assert finals[1]["startMs"] >= 300 and finals[1]["startMs"] % 100 == 0, finals[1]
print(f"OK: nối lại, gửi bù {connections[1]['frames']} frame, giờ cộng bù {finals[1]['startMs']} ms, nhãn tách riêng")
