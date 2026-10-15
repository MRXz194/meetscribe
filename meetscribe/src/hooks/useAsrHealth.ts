"use client";

import { useEffect, useState } from "react";
import { ASR_URL } from "@/lib/transcriber/config";

export type AsrHealth = { state: "checking" | "ok" | "down"; model?: string; deepgram?: boolean };

async function check(): Promise<AsrHealth> {
  try {
    const res = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    if (!res.ok) return { state: "down" };
    const body = (await res.json()) as { model?: string; engines?: { deepgram?: boolean } };
    return { state: "ok", model: body.model, deepgram: body.engines?.deepgram ?? false };
  } catch {
    return { state: "down" };
  }
}

/**
 * Kiểm tra ASR server trước khi người dùng bấm ghi, thay vì để họ chọn tab, cấp quyền micro
 * rồi mới báo lỗi. Hỏi lại mỗi 4 giây nên bật server xong là trang tự chuyển sang "sẵn sàng".
 */
export function useAsrHealth(enabled: boolean): AsrHealth {
  const [health, setHealth] = useState<AsrHealth>({ state: "checking" });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = () =>
      check().then((h) => {
        if (alive) setHealth(h);
      });
    void run();
    const timer = setInterval(run, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return health;
}
