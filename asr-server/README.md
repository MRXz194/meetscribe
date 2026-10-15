# MeetScribe ASR server

Speech-to-text tiếng Việt **miễn phí, chạy local trên CPU**, không gửi audio ra ngoài. Dựng trên [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (k2-fsa).

| Thành phần | Model | Vai trò |
| --- | --- | --- |
| VAD | Silero VAD | Cắt đoạn có tiếng người, chốt câu sau 0,4 s im lặng |
| ASR | Zipformer-vi 30M int8 ([hynt](https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h), ~6.000 giờ tiếng Việt) | Giọng nói → chữ |
| Speaker embedding | CAM++ (3D-Speaker) | Mỗi đoạn → vector 192 chiều đặc trưng giọng |
| Diarization lúc đang ghi | `SpeakerTracker` (tự viết, `pipeline.py`) | Gom cụm online theo cosine similarity, để có nhãn ngay |
| Diarization bản cuối | `OfflineSpeakerDiarization` (có sẵn trong sherpa-onnx: pyannote segmentation 3.0 + CAM++ + clustering) | Khi bấm Dừng / khi xử lý file: xem lại cả cuộc họp rồi gán lại nhãn từng câu |
| Lọc tiếng vọng | `is_echo` (tự viết) | Bỏ câu ở mic trùng câu ở cuộc họp (micro thu lại tiếng loa) |

## Engine Deepgram (tuỳ chọn, cloud)

Gửi `"engine": "deepgram"` trong message `start` (hoặc `POST /transcribe?engine=deepgram`) thì asr-server **chuyển tiếp** audio sang Deepgram thay vì tự nhận dạng ([deepgram_engine.py](deepgram_engine.py)):

```
trình duyệt ── PCM16 2 kênh ──► asr-server ── Authorization: Token <key> ──► wss://api.deepgram.com/v1/listen
            ◄── partial / final (giống hệt engine local) ──┘   nova-3, language=vi, multichannel, diarize
```

- Vì sao đi qua server: tài liệu Deepgram không ghi rõ cách trình duyệt gửi token tạm khi mở WebSocket, còn từ server thì dùng header chuẩn. Key không ra trình duyệt, và phía web không phải sửa giao thức.
- Kênh mic vẫn là "me" nhờ `multichannel=true`. Kênh meeting lấy người nói từ diarization của Deepgram; một đoạn final có nhiều người thì được tách theo từng cụm từ.
- Lọc tiếng vọng dùng lại `is_echo` của pipeline local.
- Key: `DEEPGRAM_API_KEY` trong biến môi trường, `asr-server/.env` hoặc `meetscribe/.env.local` (đọc lại mỗi phiên, không cần khởi động lại). `/health` trả `engines.deepgram` để web biết đã có key chưa.
- Chi phí: Deepgram tính theo từng kênh, ghi có mic là 2 kênh.
- **Chưa test với key thật**: đã test logic bằng message giả lập (`scripts/test_deepgram_bridge.py`) và đường lỗi với key giả (Deepgram trả 401). Tham số streaming (`diarize=true`, `language=vi`) cần xác nhận ở lần chạy thật đầu tiên.

## Dựa trên đâu và khác gì

Pipeline được dựng theo các ví dụ chính thức trong [sherpa-onnx/python-api-examples](https://github.com/k2-fsa/sherpa-onnx/tree/master/python-api-examples), rồi mở rộng cho bài toán cuộc họp:

| Ví dụ gốc | Ví dụ đó làm gì | MeetScribe làm thêm |
| --- | --- | --- |
| `vad-with-non-streaming-asr.py` | Mic → Silero VAD → ASR từng câu | Partial (chữ tạm) khi đang nói; nhiều kênh; chạy sau WebSocket thay vì đọc mic tại chỗ |
| `speaker-identification-with-vad-dynamic.py` | Gặp giọng lạ (ngưỡng 0,4) thì đăng ký `speaker_N`; không có ASR | Centroid cập nhật dần thay vì giữ embedding đầu tiên; chỉ tạo người mới khi câu ≥ 1,2 s; ngưỡng đo lại trên dữ liệu thật; ghép với ASR |
| `speaker-identification-with-vad-non-streaming-asr.py` | VAD + ASR + nhận người đã đăng ký trước | Không cần đăng ký trước; kênh mic tách riêng = "Tôi" |
| `offline-speaker-diarization.py` | Diarization cả file | **Dùng nguyên** cho bản cuối; tự viết phần gán nhãn diarization vào từng câu đã nhận dạng |
| `streaming_server.py` / `non_streaming_server.py` | WebSocket server mẫu | Giao thức riêng 2 kênh interleaved, lọc tiếng vọng, sắp câu theo thời gian, endpoint file `/transcribe` |

Ý tưởng tham khảo thêm: luồng trình duyệt → FastAPI WebSocket → partial/final của [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit); tách "giọng mình" (mic) và "người khác" (âm thanh hệ thống) như Granola / [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes).

## Chạy

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Linux/macOS: .venv/bin/pip
.venv/Scripts/python scripts/download_models.py   # ~135 MB, từ GitHub releases của sherpa-onnx
.venv/Scripts/python -m uvicorn app:app --port 8000
```

Hoặc dùng Docker (model được đóng sẵn trong image):

```bash
docker build -t meetscribe-asr .
docker run -p 8000:8000 meetscribe-asr
```

## Luồng xử lý

```
Trình duyệt: tab/màn hình ─┐ AudioContext 16 kHz     AudioWorklet        WebSocket /ws
             micro ────────┴► (trình duyệt tự hạ mẫu) ► ChannelMerger ► PCM16 2 kênh ──► server
                                                                              │
 mỗi kênh:  Silero VAD ─┬─ đang nói → decode phần dở dang ──► partial (chữ xám)
                        └─ hết câu ──► Zipformer-vi ──► text
                                     └► CAM++ embedding ──► SpeakerTracker ──► speaker (tạm)
 kênh mic:  speaker = "me" (biết chắc nhờ tách kênh vật lý)
 phát ra:   giữ câu 1,5 s → lọc echo → sắp theo thời gian ──► final
 khi Dừng:  OfflineSpeakerDiarization trên cả kênh meeting ──► gán lại nhãn ──► final_transcript
```

Gán lại nhãn: mỗi câu lấy người nói chiếm nhiều thời gian nhất trong khoảng của câu đó (không có đoạn chồng thì lấy đoạn gần nhất), đánh số lại theo thứ tự xuất hiện. Câu ở micro giữ "me". Bước này lỗi hoặc audio < 3 giây thì giữ nhãn live.

**Ai nói** (`SpeakerTracker`): mỗi người là một centroid (trung bình embedding đã chuẩn hoá).
- Đoạn mới giống centroid nào nhất mà cosine ≥ 0,45 thì là người đó, và cập nhật centroid.
- Không ai đủ giống thì tạo người mới, nhưng **chỉ khi đoạn ≥ 1,2 giây**. Đoạn ngắn hơn không đủ bằng chứng nên gán cho người vừa nói.
- Ngưỡng 0,45 chọn từ vài file mẫu ngắn, **chưa kiểm chứng trên họp thật**: khác người cosine khoảng 0,1–0,2; cùng người (đoạn dài) khoảng 0,8; đoạn khoảng 1 giây thì cùng người chỉ còn 0,3–0,5. Trên 4 file test của sherpa-onnx (`scripts/compare_diarization.py`) ngưỡng 0,45 chia thiếu người ở 2/4 file còn 0,6 đếm đúng 4/4, nhưng mẫu rất nhỏ nên chưa kết luận được. Đặt bằng `SPEAKER_THRESHOLD`.

## Số đo trên i5-12400F, chỉ CPU

| Việc | Kết quả |
| --- | --- |
| ASR Zipformer-vi 30M | RTF 0,014 (nhanh ~70 lần thời gian thực), nạp model 0,9 s |
| ASR Zipformer-vi 70k giờ (int8) | RTF 0,020 |
| Toàn pipeline 2 kênh (VAD + ASR + partial + embedding) | RTF ~0,06 |
| Độ trễ chữ chốt sau khi ngừng nói | ~0,5 s (+1,5 s khi bật lọc echo 2 kênh) |
| File 16 s qua `/transcribe` (có diarization offline) | 1,8 s |
| Diarization offline sau khi dừng | 26 s audio: 1,4 s; 57 s audio: ~3 s |

```bash
.venv/Scripts/python scripts/bench.py          # so 2 model ASR
.venv/Scripts/python scripts/test_pipeline.py  # 3 người nói + 1 câu vọng ở mic
```

## API

- `WS /ws`: gửi `{"type":"start","sampleRate":16000,"channels":["meeting","mic"]}`, sau đó PCM16 interleaved, rồi `{"type":"stop"}`. Nhận về `partial`, `final {speaker, text, startMs, endMs}`; sau stop là `status: refining`, `final_transcript {segments, speakers}` (nhãn bản cuối), `done`.
- `POST /transcribe`: body là PCM16 mono 16 kHz, trả `{"segments": [...], "durationSec"}`.
- `GET /health`

Biến môi trường: `ASR_MODEL`, `NUM_THREADS`, `SPEAKER_THRESHOLD`, `DIARIZATION_THRESHOLD`, `CORS_ORIGINS`, `MODELS_DIR`.

## License của model

| Model | License |
| --- | --- |
| Zipformer-vi 30M (mặc định) | **cc-by-nc-nd-4.0**: phi thương mại, không cho tạo bản phái sinh. Phù hợp demo cá nhân; không đẩy image chứa model này lên registry công khai |
| Zipformer-vi 70k giờ (`ASR_MODEL=sherpa-onnx-zipformer-vi-int8-2025-04-20`) | apache-2.0 |
| pyannote segmentation 3.0 (diarization bản cuối) | MIT |
| sherpa-onnx (thư viện và repo) | Apache-2.0 |
| Silero VAD | MIT (trang repo có thêm 1 huy hiệu ghi CC BY-NC 4.0 mâu thuẫn, nhưng mô tả và sidebar đều ghi MIT) |
| CAM++ (3D-Speaker) | Repo Apache-2.0; license riêng của file model trên ModelScope chưa thấy ghi, chưa kiểm tra |
| Phụ thuộc Python: fastapi, uvicorn, numpy, soundfile | MIT, BSD-3-Clause, BSD-3-Clause, BSD-3-Clause |

Nguồn: model card trên Hugging Face ([hynt](https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h), [zzasdf](https://huggingface.co/zzasdf/viet_iter3_pseudo_label)).

## Giới hạn

- Model ra chữ thường, không dấu câu. Server viết hoa đầu câu; LLM tóm tắt không bị ảnh hưởng.
- Nhãn lúc đang ghi là tạm; bản cuối dùng diarization offline. Chưa có số đo DER trên họp tiếng Việt thật cho cả hai. Giọng giống nhau hoặc nói chồng lên nhau dễ nhầm.
- Chưa thêm từ vựng riêng (tên người, tên dự án). sherpa-onnx có hỗ trợ hotwords cho transducer, có thể bổ sung.
