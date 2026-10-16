import type { TranscriptToken } from "../types";
import { ASR_URL } from "./config";
import type { AudioInput, DeepgramLanguage, LiveTranscriber, TranscriberHandlers } from "./types";

type FinalMessage = {
  type: "final";
  id: number;
  channel: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
};

type ServerMessage =
  | { type: "ready" | "done" }
  | { type: "status"; message: string }
  | { type: "error"; message: string }
  | { type: "partial"; channel: string; speaker: string; text: string }
  | FinalMessage
  | { type: "final_transcript"; segments: FinalMessage[]; speakers: number };

const SAMPLE_RATE = 16000;
/** Mất kết nối thì giữ tối đa chừng này audio để gửi bù sau khi nối lại */
const MAX_QUEUE_SEC = 60;
/** Thời gian chờ giữa các lần nối lại (tổng ~30 s) */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gửi audio tới ASR server tự host (asr-server/).
 * Mỗi nguồn là 1 kênh riêng trong PCM16 interleaved: kênh 0 = meeting, kênh 1 = mic.
 * Server biết chắc câu ở kênh mic là "me", chỉ phải đoán người nói ở kênh meeting.
 * engine "local": server tự nhận dạng bằng sherpa-onnx; "deepgram": server chuyển tiếp sang Deepgram.
 *
 * Rớt WebSocket giữa chừng thì tự nối lại: audio được giữ trong hàng chờ (tối đa 60 s) rồi gửi bù,
 * thời gian của phiên mới được cộng bù, nhãn người nói của phiên mới đánh số tiếp để không gộp nhầm.
 */
export class LocalTranscriber implements LiveTranscriber {
  constructor(
    private readonly engine: "local" | "deepgram" = "local",
    private readonly language: DeepgramLanguage = "vi",
  ) {}

  // Sau khi dừng, server còn chạy diarization offline cả cuộc họp (~3 s mỗi phút audio)
  readonly stopTimeoutMs = 10 * 60 * 1000;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private partials = new Map<string, TranscriptToken>();
  private handlers: TranscriberHandlers | null = null;
  private finished = false;
  private stopRequested = false;
  private cancelled = false;
  private channelCount = 1;
  private serverNotice = false;
  private silentChannels = new Set<string>();

  // Trạng thái nối lại
  private reconnecting = false;
  private reconnects = 0;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private producedBytes = 0;
  private offsetMs = 0; // cộng vào thời gian của phiên server hiện tại
  private speakerBase = 0; // cộng vào nhãn người nói (số) của phiên server hiện tại
  private maxSpeaker = 0;

  private toToken(m: Pick<FinalMessage, "text" | "speaker" | "startMs" | "endMs">): TranscriptToken {
    // 1 câu = 1 token; dấu cách đầu để nối với câu trước cùng người nói
    return {
      text: ` ${m.text}`,
      speaker: this.speakerLabel(m.speaker),
      startMs: m.startMs + this.offsetMs,
      endMs: m.endMs + this.offsetMs,
      isFinal: true,
    };
  }

  private speakerLabel(speaker: string) {
    const n = Number.parseInt(speaker, 10);
    if (Number.isNaN(n)) return speaker; // "me" hoặc rỗng
    const label = n + this.speakerBase;
    this.maxSpeaker = Math.max(this.maxSpeaker, label);
    return String(label);
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ASR_URL.replace(/^http/, "ws")}/ws`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.onerror = null;
        ws.onmessage = (e) => {
          if (this.ws === ws) this.onMessage(JSON.parse(e.data) as ServerMessage);
        };
        ws.onclose = () => this.onClose(ws);
        resolve(ws);
      };
      ws.onerror = () =>
        reject(new Error(`Không kết nối được ASR server ở ${ASR_URL}. Đã chạy asr-server chưa?`));
    });
  }

  private sendStart(ws: WebSocket) {
    const channels = this.channelCount > 1 ? ["meeting", "mic"] : ["meeting"];
    ws.send(JSON.stringify({ type: "start", sampleRate: SAMPLE_RATE, channels, engine: this.engine, language: this.language }));
  }

  async start(input: AudioInput, handlers: TranscriberHandlers) {
    this.handlers = handlers;
    this.channelCount = input.mic ? 2 : 1;

    const ws = await this.openSocket();
    if (this.cancelled) return ws.close();
    this.ws = ws;
    this.sendStart(ws);

    // Đồ thị audio: mỗi nguồn vào 1 kênh riêng của ChannelMerger → worklet đóng gói PCM → WebSocket.
    // Context chạy ở 16 kHz nên trình duyệt tự hạ mẫu từ 48 kHz (có lọc chống méo), mình không tự làm.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    void ctx.resume();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const merger = ctx.createChannelMerger(this.channelCount);
    ctx.createMediaStreamSource(input.meeting).connect(merger, 0, 0);
    if (input.mic) ctx.createMediaStreamSource(input.mic).connect(merger, 0, 1);

    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: this.channelCount,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: { channels: this.channelCount },
    });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.sendAudio(e.data);
    merger.connect(node);
    // Worklet cần nối tới destination để được chạy; gain 0 để không phát lại ra loa
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  }

  private sendAudio(buf: ArrayBuffer) {
    this.producedBytes += buf.byteLength;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && !this.reconnecting) {
      ws.send(buf);
      return;
    }
    // Đang mất kết nối: giữ lại để gửi bù, bỏ phần cũ nhất nếu quá dài
    this.queue.push(buf);
    this.queuedBytes += buf.byteLength;
    const max = MAX_QUEUE_SEC * SAMPLE_RATE * 2 * this.channelCount;
    while (this.queuedBytes > max && this.queue.length) this.queuedBytes -= this.queue.shift()!.byteLength;
  }

  private onClose(ws: WebSocket) {
    if (ws !== this.ws || this.finished || this.cancelled) return;
    // Server đóng sau khi người dùng đã bấm dừng mà chưa kịp "done": kết thúc với những gì đã có
    if (this.stopRequested && !this.reconnecting) return this.finish();
    if (!this.reconnecting) void this.reconnect();
  }

  private async reconnect() {
    this.reconnecting = true;
    this.handlers?.onNotice?.("Mất kết nối ASR server, đang nối lại… (audio vẫn được giữ lại)");
    for (const delay of RECONNECT_DELAYS_MS) {
      await wait(delay);
      if (this.finished || this.cancelled) return;
      try {
        const ws = await this.openSocket();
        if (this.cancelled) return ws.close();
        // Server mới đếm giờ và đánh số người nói lại từ đầu: bù theo audio đã qua trước phần được gửi lại
        this.offsetMs = Math.round(
          (this.producedBytes - this.queuedBytes) / (2 * this.channelCount) / (SAMPLE_RATE / 1000),
        );
        this.speakerBase = this.maxSpeaker;
        this.reconnects++;
        this.partials.clear();
        this.ws = ws;
        this.sendStart(ws);
        for (const buf of this.queue) ws.send(buf);
        this.queue = [];
        this.queuedBytes = 0;
        this.reconnecting = false;
        if (this.stopRequested) ws.send(JSON.stringify({ type: "stop" }));
        this.handlers?.onNotice?.(null);
        return;
      } catch {
        // thử lại ở vòng sau
      }
    }
    this.reconnecting = false;
    if (this.stopRequested) return this.finish();
    // Không nối lại được: báo lỗi, phần đã ghi vẫn còn để người dùng lưu
    this.handlers?.onNotice?.(null);
    this.handlers?.onError("Mất kết nối ASR server và không nối lại được. Phần đã ghi vẫn còn, bạn có thể lưu lại.");
  }

  private onMessage(msg: ServerMessage) {
    const h = this.handlers;
    if (!h) return;
    // Có kết quả mới nghĩa là server đã nối lại xong
    if (this.serverNotice && (msg.type === "partial" || msg.type === "final")) {
      this.serverNotice = false;
      h.onNotice?.(null);
    }
    switch (msg.type) {
      case "partial": {
        if (msg.text) {
          this.partials.set(msg.channel, { text: msg.text, speaker: this.speakerLabel(msg.speaker), isFinal: false });
        } else {
          this.partials.delete(msg.channel);
        }
        h.onTokens([], [...this.partials.values()]);
        break;
      }
      case "final":
        h.onTokens([this.toToken(msg)], [...this.partials.values()]);
        break;
      case "final_transcript":
        // Bản cuối: cùng các câu đó nhưng nhãn người nói lấy từ diarization offline.
        // Sau khi đã nối lại thì chỉ phủ được phần phiên cuối, nên giữ nguyên nhãn live.
        if (this.reconnects === 0) h.onReplaceFinals?.(msg.segments.map((m) => this.toToken(m)));
        break;
      case "status":
        if (msg.message.startsWith("silent:") || msg.message.startsWith("audio_ok:")) {
          const [kind, channel] = msg.message.split(":");
          if (kind === "silent") this.silentChannels.add(channel);
          else this.silentChannels.delete(channel);
          h.onWarning?.(this.silenceWarning());
        } else if (msg.message === "reconnecting") {
          this.serverNotice = true;
          h.onNotice?.("Mạng tới Deepgram chập chờn, server đang nối lại… (audio vẫn được giữ lại)");
        }
        break;
      case "error":
        h.onError(msg.message);
        break;
      case "done":
        this.finish();
        break;
    }
  }

  private silenceWarning(): string | null {
    const parts: string[] = [];
    if (this.silentChannels.has("meeting")) {
      parts.push(
        "Chưa nghe thấy âm thanh của cuộc họp. Khi chọn tab, hãy tick “Chia sẻ âm thanh tab” (hoặc “Chia sẻ âm thanh hệ thống” nếu chia sẻ màn hình), và chắc chắn cuộc họp đang có tiếng.",
      );
    }
    if (this.silentChannels.has("mic")) {
      parts.push("Chưa nghe thấy micro của bạn. Kiểm tra micro đã bật và đúng thiết bị.");
    }
    return parts.length ? parts.join(" ") : null;
  }

  private finish() {
    this.finished = true;
    this.ws?.close();
    this.handlers?.onFinished();
    this.handlers = null;
  }

  private closeAudio() {
    void this.ctx?.close();
    this.ctx = null;
  }

  stop() {
    this.stopRequested = true;
    this.closeAudio();
    // Đang nối lại thì lệnh dừng được gửi ngay sau khi nối xong
    if (!this.reconnecting && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  cancel() {
    this.cancelled = true;
    this.handlers = null;
    this.closeAudio();
    this.ws?.close();
    this.ws = null;
    this.queue = [];
    this.queuedBytes = 0;
  }
}

/** Giải mã file ghi âm ngay trên trình duyệt về PCM16 mono 16 kHz rồi gửi ASR server. */
export async function transcribeFileLocally(
  file: File,
  engine: "local" | "deepgram" = "local",
  language: DeepgramLanguage = "vi",
) {
  const ctx = new OfflineAudioContext(1, 16000, 16000);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  const res = await fetch(`${ASR_URL}/transcribe?engine=${engine}&language=${language}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm.buffer,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `ASR server lỗi ${res.status}`);
  }
  const body = (await res.json()) as {
    durationSec: number;
    segments: { speaker: string; text: string; startMs: number; endMs: number }[];
  };
  return body;
}
