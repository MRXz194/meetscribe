# MeetScribe

Transcript tiếng Việt realtime cho mọi cuộc họp trên máy tính (Google Meet, Zoom, Teams, bản web lẫn bản app) mà **không cần bot vào phòng**. Có tách người nói, biên bản AI (tóm tắt, quyết định, việc cần làm) và xuất TXT/Markdown/SRT.

## Chạy (miễn phí hoàn toàn)

Cài 1 lần: ASR server theo [../asr-server/README.md](../asr-server/README.md) (tạo venv, cài thư viện, tải model), rồi:

```bash
npm install
cp .env.example .env.local   # chỉ cần 1 key LLM miễn phí cho phần tóm tắt
npm run dev:all              # bật cả ASR server (cổng 8000) lẫn web (http://localhost:3000)
```

`npm run dev:all` in log của 2 bên với tiền tố `[asr]` và `[web]`; Ctrl+C dừng cả hai. Nếu ASR server đã chạy sẵn thì chỉ bật web. Nếu ASR server chết giữa chừng thì web vẫn chạy và trang Ghi báo "ASR server chưa chạy".

- **Nhận dạng giọng nói**: chọn engine ngay trên trang Ghi.
  - **Local** (mặc định): sherpa-onnx trên CPU, không cần key, audio không rời máy.
  - **Deepgram**: cloud, nova-3 tiếng Việt, tách người nói. Cần `DEEPGRAM_API_KEY` trong `.env.local` (đăng ký có credit miễn phí). Audio đi qua asr-server rồi sang Deepgram nên key không lộ ra trình duyệt.
- **Tóm tắt**: miễn phí với `GOOGLE_GENERATIVE_AI_API_KEY` (Google AI Studio, không cần thẻ) hoặc `GROQ_API_KEY`. Muốn offline hoàn toàn thì dùng `LLM_PROVIDER=ollama`.
- Dùng Chrome hoặc Edge trên desktop.

## Cách dùng

| Cuộc họp | Chọn nguồn | Trong hộp thoại chia sẻ của trình duyệt |
| --- | --- | --- |
| Google Meet, Zoom web, Teams web | Cuộc họp trên trình duyệt | Chọn tab cuộc họp, bật **Chia sẻ âm thanh tab** |
| Zoom / Teams / Discord app | App họp trên máy | Chọn **Toàn màn hình**, bật **Chia sẻ âm thanh hệ thống** (Windows; macOS cần Chrome 141+ và macOS 14.2+) |
| File ghi âm có sẵn | Upload file ghi âm (trang chủ) | — |

Với engine Local, micro là **kênh riêng**: câu nào nói vào micro được ghi chắc chắn là "Tôi", còn người trong cuộc họp được nhận diện qua giọng. Nên dùng tai nghe; nếu dùng loa thì server tự lọc câu bị micro thu lại.

Trải nghiệm khi ghi:
- Trang Ghi kiểm tra ASR server mỗi 4 giây: chưa chạy thì khoá nút Ghi và hướng dẫn cách bật, nên người dùng không phải chọn tab, cấp quyền micro rồi mới gặp lỗi.
- Sau khi chọn tab, trình duyệt **giữ người dùng ở lại MeetScribe** thay vì nhảy sang tab cuộc họp (`CaptureController.setFocusBehavior`, Chrome 109+).
- Nút **Cửa sổ nổi** mở một cửa sổ transcript nhỏ luôn nằm trên cùng (Document Picture-in-Picture, Chrome/Edge), để xem chữ ngay trên Meet hoặc Zoom mà không cần chuyển tab.
- Dừng bằng nút "Dừng & lưu" hay bằng thanh "Dừng chia sẻ" của trình duyệt đều tự lưu cuộc họp.

## Kiến trúc

```
Trình duyệt                                         Next.js server (localhost:3000)
┌──────────────────────────────────┐                ┌──────────────────────────────┐
│ lib/audio/sources.ts             │                │ /api/meetings    lưu JSON    │
│  tab | màn hình, mic (2 nguồn)   │                │ /api/.../summarize  LLM      │
│ lib/transcriber/                 │                │                              │
│  └ local.ts  ─ AudioWorklet ─────┼── WebSocket ─► │                              │
│      2 kênh PCM16 16 kHz         │                └──────────────────────────────┘
│                                  │
│ hooks/useLiveTranscript.ts       │                ASR server (localhost:8000, ../asr-server)
└──────────────────────────────────┘ ─────────────► VAD → Zipformer-vi → CAM++ → SpeakerTracker
```

- **Nguồn audio là adapter** (`src/lib/audio/sources.ts`): mỗi nguồn trả về một `MediaStream`. Thêm Chrome extension hay bot sau này chỉ là thêm một nguồn.
- **ASR là plugin** (`src/lib/transcriber/types.ts`): UI chỉ biết interface `LiveTranscriber`. Cả hai engine (Local và Deepgram) đều đi qua asr-server bằng `LocalTranscriber`; đổi ngay trên giao diện.
- **Tách kênh mic/cuộc họp** (engine Local): AudioContext chạy ở 16 kHz (trình duyệt tự hạ mẫu), AudioWorklet chỉ đóng gói PCM 2 kênh. Server biết chắc kênh mic là "Tôi", chỉ phải đoán người nói ở kênh cuộc họp.
- **Nhãn người nói 2 bước** (engine Local): lúc đang ghi là nhãn tạm (gom cụm online); bấm Dừng thì server chạy diarization offline của sherpa-onnx trên cả cuộc họp và gửi lại bản cuối, UI thay toàn bộ nhãn trước khi lưu.
- **Key thật không lên trình duyệt** (engine Deepgram): key nằm ở asr-server, trình duyệt chỉ nói chuyện với asr-server.
- **Lưu trữ** (`src/lib/server/store.ts`): file JSON trong `data/meetings/`, vì bản này chạy localhost. Đổi sang Postgres chỉ cần viết lại file này.
- **Tóm tắt** (`src/lib/server/summarize.ts`): AI SDK với `Output.object` + schema zod, nên luôn nhận về JSON đúng cấu trúc. Đổi provider bằng biến môi trường.
- **Upload**: trình duyệt giải mã file về PCM 16 kHz, gửi `POST /transcribe` của asr-server (engine đang chọn), rồi lưu như cuộc họp thường.

## Cấu trúc

```
src/
├─ lib/audio/sources.ts         getMeetingStream, getMicStream, mixStreams (+ meter âm lượng)
├─ lib/transcriber/types.ts     interface LiveTranscriber
├─ lib/transcriber/local.ts     LocalTranscriber (local + deepgram qua asr-server)
├─ lib/transcript.ts            gộp token → đoạn theo người nói, export TXT/MD/SRT
├─ lib/server/                  store (JSON), summarize (LLM)
├─ hooks/useLiveTranscript.ts   start/stop, token final + partial, đồng hồ, meter
└─ app/                         / (danh sách), /record, /meetings/[id], api/*
```

## Giới hạn hiện tại

- Người dùng phải tự chọn tab/màn hình và tick âm thanh. Bản extension sẽ bỏ bước này (bắt bằng tabCapture, hiện transcript ở side panel).
- Người nói trong cuộc họp được nhận diện qua giọng (online clustering): giọng giống nhau hoặc câu rất ngắn có thể nhầm, vì vậy có tính năng đổi tên người nói. Model chỉ biết "Người nói 2", không biết tên thật.
- Model local ra chữ thường, không dấu câu.
- Chưa có đăng nhập và nhiều người dùng.
