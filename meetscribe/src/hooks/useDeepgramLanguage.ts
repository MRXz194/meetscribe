"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEEPGRAM_LANGUAGES, type DeepgramLanguage } from "@/lib/transcriber/types";

const KEY = "meetscribe:deepgram-language";
const listeners = new Set<() => void>();

function read(): DeepgramLanguage {
  try {
    const value = localStorage.getItem(KEY);
    return value && value in DEEPGRAM_LANGUAGES ? (value as DeepgramLanguage) : "vi";
  } catch {
    return "vi";
  }
}

/** Ngôn ngữ cho engine Deepgram, nhớ theo trình duyệt. Mặc định tiếng Việt. */
export function useDeepgramLanguage() {
  const language = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => "vi" as DeepgramLanguage,
  );
  const setLanguage = useCallback((value: DeepgramLanguage) => {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // không lưu được thì chỉ đổi trong phiên này
    }
    listeners.forEach((cb) => cb());
  }, []);
  return [language, setLanguage] as const;
}
