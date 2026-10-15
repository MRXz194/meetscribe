"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ENGINES, type EngineId } from "@/lib/transcriber/types";

const KEY = "meetscribe:engine";
const listeners = new Set<() => void>();

function read(): EngineId {
  try {
    const value = localStorage.getItem(KEY);
    return value && value in ENGINES ? (value as EngineId) : "local";
  } catch {
    return "local";
  }
}

/** Engine ASR đang chọn, nhớ theo trình duyệt. Mặc định local (miễn phí). */
export function useEngine() {
  const engine = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => "local" as EngineId,
  );
  const setEngine = useCallback((value: EngineId) => {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // không lưu được thì chỉ đổi trong phiên này
    }
    listeners.forEach((cb) => cb());
  }, []);
  return [engine, setEngine] as const;
}
