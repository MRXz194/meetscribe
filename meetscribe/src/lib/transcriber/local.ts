import type { TranscriptToken } from "../types";
import { ASR_URL } from "./config";
import type { AudioInput, LiveTranscriber, TranscriberHandlers } from "./types";

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

// 1 câu = 1 token; dấu cách đầu để nối với câu trước cùng người nói
const toToken = (m: FinalMessage): TranscriptToken => ({
  text: ` ${m.text}`,
  speaker: m.speaker,
  startMs: m.startMs,
  endMs: m.endMs,
  isFinal: true,
});

/**
 * Gửi audio tới ASR server tự host (asr-server/).
 * Mỗi nguồn là 1 kênh riêng trong PCM16 interleaved: kênh 0 = meeting, kênh 1 = mic.
 * Server biết chắc câu ở kênh mic là "me", chỉ phải đoán người nói ở kênh meeting.
 * engine "local": server tự nhận dạng bằng sherpa-onnx; "deepgram": server chuyển tiếp sang Deepgram.
 */
export class LocalTranscriber implements LiveTranscriber {
  constructor(private readonly engine: "local" | "deepgram" = "local") {}

  // Sau khi dừng, server còn chạy diarization offline cả cuộc họp (~3 s mỗi phút audio)
  readonly stopTimeoutMs = 10 * 60 * 1000;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private partials = new Map<string, TranscriptToken>();
  private handlers: TranscriberHandlers | null = null;
  private finished = false;

  async start(input: AudioInput, handlers: TranscriberHandlers) {
    this.handlers = handlers;
    const channels = input.mic ? ["meeting", "mic"] : ["meeting"];

    const ws = new WebSocket(`${ASR_URL.replace(/^http/, "ws")}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(new Error(`Không kết nối được ASR server ở ${ASR_URL}. Đã chạy asr-server chưa?`));
    });
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      this.closeAudio();
      // Mất kết nối giữa chừng: vẫn kết thúc phiên với những gì đã có
      if (!this.finished) this.finish();
    };
    ws.send(JSON.stringify({ type: "start", sampleRate: 16000, channels, engine: this.engine }));

    // Đồ thị audio: mỗi nguồn vào 1 kênh riêng của ChannelMerger → worklet đóng gói PCM → WebSocket.
    // Context chạy ở 16 kHz nên trình duyệt tự hạ mẫu từ 48 kHz (có lọc chống méo), mình không tự làm.
    const ctx = new AudioContext({ sampleRate: 16000 });
    this.ctx = ctx;
    void ctx.resume();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const merger = ctx.createChannelMerger(channels.length);
    ctx.createMediaStreamSource(input.meeting).connect(merger, 0, 0);
    if (input.mic) ctx.createMediaStreamSource(input.mic).connect(merger, 0, 1);

    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: channels.length,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: { channels: channels.length },
    });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    merger.connect(node);
    // Worklet cần nối tới destination để được chạy; gain 0 để không phát lại ra loa
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  }

  private onMessage(msg: ServerMessage) {
    const h = this.handlers;
    if (!h) return;
    switch (msg.type) {
      case "partial": {
        if (msg.text) this.partials.set(msg.channel, { text: msg.text, speaker: msg.speaker, isFinal: false });
        else this.partials.delete(msg.channel);
        h.onTokens([], [...this.partials.values()]);
        break;
      }
      case "final":
        h.onTokens([toToken(msg)], [...this.partials.values()]);
        break;
      case "final_transcript":
        // Bản cuối: cùng các câu đó nhưng nhãn người nói lấy từ diarization offline
        h.onReplaceFinals?.(msg.segments.map(toToken));
        break;
      case "error":
        h.onError(msg.message);
        break;
      case "done":
        this.finish();
        break;
    }
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
    this.closeAudio();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" }));
  }

  cancel() {
    this.handlers = null;
    this.closeAudio();
    this.ws?.close();
    this.ws = null;
  }
}

/** Giải mã file ghi âm ngay trên trình duyệt về PCM16 mono 16 kHz rồi gửi ASR server. */
export async function transcribeFileLocally(file: File, engine: "local" | "deepgram" = "local") {
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

  const res = await fetch(`${ASR_URL}/transcribe?engine=${engine}`, {
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
