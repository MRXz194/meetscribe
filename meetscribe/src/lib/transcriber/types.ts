import type { TranscriptToken } from "../types";

/** Audio đầu vào giữ tách kênh: engine nào hỗ trợ thì dùng kênh mic để biết chắc câu nào là "Tôi". */
export type AudioInput = {
  meeting: MediaStream;
  mic: MediaStream | null;
};

export type TranscriberHandlers = {
  /** finalTokens: chỉ những token mới được chốt; partialTokens: toàn bộ phần đang nghe */
  onTokens: (finalTokens: TranscriptToken[], partialTokens: TranscriptToken[]) => void;
  /** Engine gửi lại toàn bộ câu đã chốt với nhãn người nói chính xác hơn (bước offline khi dừng) */
  onReplaceFinals?: (finalTokens: TranscriptToken[]) => void;
  onError: (message: string) => void;
  onFinished: () => void;
};

/**
 * Interface chung cho mọi engine speech-to-text realtime:
 * - LocalTranscriber: ASR server tự host (sherpa-onnx, miễn phí, chạy CPU)
 * - SonioxTranscriber: Soniox cloud
 * UI chỉ biết interface này nên đổi engine không phải sửa UI.
 */
export interface LiveTranscriber {
  /** Sau khi stop(), chờ tối đa bao lâu cho onFinished trước khi tự kết thúc với kết quả đang có */
  readonly stopTimeoutMs: number;
  start(input: AudioInput, handlers: TranscriberHandlers): Promise<void>;
  /** Dừng và chờ engine trả nốt kết quả cuối (onFinished) */
  stop(): void;
  /** Huỷ ngay, bỏ kết quả */
  cancel(): void;
}

export type EngineId = "local" | "deepgram" | "soniox";

/** Engine đi qua asr-server (cùng giao thức 2 kênh); Soniox thì trình duyệt nối thẳng. */
export const VIA_ASR_SERVER: EngineId[] = ["local", "deepgram"];

export const ENGINES: Record<EngineId, { label: string; desc: string }> = {
  local: { label: "Local", desc: "Miễn phí, sherpa-onnx chạy trên máy, audio không rời máy" },
  deepgram: {
    label: "Deepgram",
    desc: "Cloud, nova-3 tiếng Việt, tách người nói. Đi qua asr-server nên key không lộ; tính phí theo từng kênh",
  },
  soniox: { label: "Soniox", desc: "Cloud trả phí theo giờ, cần SONIOX_API_KEY" },
};

export async function createTranscriber(engine: EngineId): Promise<LiveTranscriber> {
  if (engine === "soniox") {
    const { SonioxTranscriber } = await import("./soniox");
    return new SonioxTranscriber();
  }
  const { LocalTranscriber } = await import("./local");
  return new LocalTranscriber(engine);
}
