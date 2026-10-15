# MeetScribe

Hệ thống ghi âm và nhận dạng giọng nói tiếng Việt thời gian thực cho các cuộc họp (Google Meet, Zoom, Teams,...) kèm bóc tách người nói (speaker diarization) và tóm tắt biên bản tự động bằng AI mà **không cần bot vào phòng**.

---

## Cấu trúc dự án

- **[`meetscribe/`](meetscribe/)**: Web app Next.js (giao diện ghi âm, cửa sổ nổi Document PiP, biên tập transcript, tóm tắt cuộc họp qua LLM).
- **[`asr-server/`](asr-server/)**: ASR server local chạy FastAPI & sherpa-onnx (Silero VAD, Zipformer tiếng Việt 30M, CAM++ Diarization) hoặc bridge sang Deepgram.

---

## Hướng dẫn cài đặt & Khởi chạy nhanh

### 1. Cài đặt ASR Server (1 lần duy nhất)
```bash
cd asr-server
python -m venv .venv

# Windows:
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python scripts/download_models.py

# Linux / macOS:
# .venv/bin/pip install -r requirements.txt
# .venv/bin/python scripts/download_models.py
```

### 2. Cài đặt Web App
```bash
cd ../meetscribe
npm install
cp .env.example .env.local    # Điền key LLM (Google AI Studio miễn phí hoặc Groq)
```

### 3. Chạy toàn bộ hệ thống
Trong thư mục `meetscribe`, chỉ cần 1 lệnh:
```bash
npm run dev:all
```
- **Web App**: `http://localhost:3000`
- **ASR Server**: `http://localhost:8000`
