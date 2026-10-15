"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// Document Picture-in-Picture (Chrome/Edge) chưa có trong lib.dom của TypeScript
type DocumentPip = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
};
const getPip = () => (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

/** Chép CSS của trang sang cửa sổ nổi để Tailwind/shadcn hiển thị giống hệt. */
function copyStyles(target: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.document.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      target.document.head.appendChild(style);
    } catch {
      // Stylesheet khác origin không đọc được cssRules: gắn lại bằng thẻ link
      if (sheet.href) {
        const link = target.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
  target.document.documentElement.className = document.documentElement.className;
  target.document.body.className = "bg-background text-foreground antialiased";
}

/**
 * Cửa sổ nhỏ luôn nằm trên cùng (kể cả khi đang ở tab Meet hay app Zoom),
 * để người dùng xem transcript mà không phải chuyển tab. Thay được phần lớn lý do cần extension.
 */
export function useDocumentPip() {
  const supported = useSyncExternalStore(
    () => () => {},
    () => getPip() !== undefined,
    () => false,
  );
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  // Phải gọi từ click của người dùng (trình duyệt yêu cầu user gesture)
  const open = useCallback(async () => {
    const pip = getPip();
    if (!pip) return;
    if (pip.window) return setPipWindow(pip.window);
    const win = await pip.requestWindow({ width: 440, height: 320 });
    win.document.title = "MeetScribe – Transcript";
    copyStyles(win);
    win.addEventListener("pagehide", () => setPipWindow(null));
    setPipWindow(win);
  }, []);

  const close = useCallback(() => {
    getPip()?.window?.close();
    setPipWindow(null);
  }, []);

  // Rời trang thì đóng cửa sổ nổi
  useEffect(() => () => getPip()?.window?.close(), []);

  return { supported, pipWindow, open, close };
}
