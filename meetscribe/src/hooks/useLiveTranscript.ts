"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureError,
  createMeter,
  getMeetingStream,
  getMicStream,
  stopStreams,
  type AudioMeter,
  type CaptureMode,
} from "@/lib/audio/sources";
import { createTranscriber, type EngineId, type LiveTranscriber } from "@/lib/transcriber/types";
import type { TranscriptToken } from "@/lib/types";

export type LiveStatus = "idle" | "starting" | "recording" | "stopping" | "done" | "error";

export type StartOptions = { mode: CaptureMode; withMic: boolean; engine: EngineId };

/** Chèn token final theo thời gian: 2 kênh (mic/meeting) có thể chốt câu lệch nhau. */
function insertByTime(list: TranscriptToken[], tokens: TranscriptToken[]) {
  const out = [...list];
  for (const t of tokens) {
    let i = out.length;
    if (t.startMs !== undefined) {
      while (i > 0 && (out[i - 1].startMs ?? -1) > t.startMs) i--;
    }
    out.splice(i, 0, t);
  }
  return out;
}

/**
 * UI chỉ biết hook này: bắt đầu/dừng ghi, nhận token final + partial, đồng hồ, mức âm.
 * Engine cụ thể được tạo qua createTranscriber và có thể thay thế.
 */
export function useLiveTranscript(options: { onComplete?: (tokens: TranscriptToken[]) => void } = {}) {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [finalTokens, setFinalTokens] = useState<TranscriptToken[]>([]);
  const [partialTokens, setPartialTokens] = useState<TranscriptToken[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  const transcriberRef = useRef<LiveTranscriber | null>(null);
  const meterRef = useRef<AudioMeter | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const finalRef = useRef<TranscriptToken[]>([]);
  const startedAtRef = useRef(0);
  const finishResolverRef = useRef<((tokens: TranscriptToken[]) => void) | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(options.onComplete);
  useEffect(() => {
    onCompleteRef.current = options.onComplete;
  });

  const cleanup = useCallback(() => {
    meterRef.current?.stop();
    meterRef.current = null;
    stopStreams(streamsRef.current);
    streamsRef.current = [];
  }, []);

  // Đồng hồ + meter âm lượng khi đang ghi
  useEffect(() => {
    if (status !== "recording") return;
    let frame = 0;
    const tick = () => {
      setElapsedMs(Date.now() - startedAtRef.current);
      setLevel(meterRef.current?.getLevel() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status]);

  // Rời trang khi đang ghi thì huỷ phiên
  useEffect(() => {
    return () => {
      transcriberRef.current?.cancel();
      meterRef.current?.stop();
      stopStreams(streamsRef.current);
    };
  }, []);

  // Kết thúc phiên dù dừng bằng nút trong app, thanh "Dừng chia sẻ" của trình duyệt hay mất kết nối
  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    cleanup();
    setPartialTokens([]);
    setStatus("done");
    finishResolverRef.current?.(finalRef.current);
    finishResolverRef.current = null;
    onCompleteRef.current?.(finalRef.current);
  }, [cleanup]);

  const stoppingRef = useRef<Promise<TranscriptToken[]> | null>(null);

  const stop = useCallback((): Promise<TranscriptToken[]> => {
    // Dừng chia sẻ cũng bắn sự kiện "ended" → stop() bị gọi lần 2; trả lại đúng promise cũ
    if (stoppingRef.current) return stoppingRef.current;
    stoppingRef.current = new Promise((resolve) => {
      if (!transcriberRef.current) return resolve(finalRef.current);
      finishResolverRef.current = resolve;
      setStatus("stopping");
      // Ngừng thu ngay; engine xử lý nốt phần audio đã nhận rồi báo onFinished
      stopStreams(streamsRef.current);
      transcriberRef.current.stop();
      // Phòng khi engine không gọi onFinished (mất mạng): vẫn trả kết quả đã có
      setTimeout(() => finishResolverRef.current && finish(), transcriberRef.current.stopTimeoutMs);
    });
    return stoppingRef.current;
  }, [finish]);

  const start = useCallback(
    async ({ mode, withMic, engine }: StartOptions) => {
      setError(null);
      setStatus("starting");
      stoppingRef.current = null;
      completedRef.current = false;
      finalRef.current = [];
      setFinalTokens([]);
      setPartialTokens([]);
      setElapsedMs(0);

      try {
        // getDisplayMedia phải được gọi đầu tiên, khi click còn hiệu lực
        const meeting = await getMeetingStream(mode);
        streamsRef.current = [meeting];
        const mic = withMic ? await getMicStream() : null;
        if (mic) streamsRef.current.push(mic);

        const meter = createMeter(streamsRef.current);
        meterRef.current = meter;
        meter.onSourceEnded(() => void stop());

        const transcriber = await createTranscriber(engine);
        transcriberRef.current = transcriber;
        await transcriber.start(
          { meeting, mic },
          {
            onTokens: (finals, partials) => {
              if (finals.length) {
                finalRef.current = insertByTime(finalRef.current, finals);
                setFinalTokens(finalRef.current);
              }
              setPartialTokens(partials);
            },
            onReplaceFinals: (finals) => {
              finalRef.current = insertByTime([], finals);
              setFinalTokens(finalRef.current);
            },
            onError: (message) => {
              // Lỗi thì không tự lưu; người dùng chọn "Lưu phần đã ghi được"
              completedRef.current = true;
              setError(message);
              setStatus("error");
              cleanup();
              finishResolverRef.current?.(finalRef.current);
              finishResolverRef.current = null;
            },
            onFinished: finish,
          },
        );
        startedAtRef.current = Date.now();
        setStatus("recording");
      } catch (err) {
        transcriberRef.current?.cancel();
        transcriberRef.current = null;
        cleanup();
        setError(err instanceof CaptureError || err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    },
    [cleanup, finish, stop],
  );

  return { status, error, finalTokens, partialTokens, elapsedMs, level, start, stop };
}
