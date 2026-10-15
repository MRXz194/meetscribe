/**
 * Adapter nguồn audio: mỗi hàm trả về một MediaStream chỉ có audio.
 * Transcriber không biết audio đến từ đâu, nên thêm nguồn mới (extension, bot…)
 * không phải sửa phần còn lại.
 */

export type CaptureMode = "tab" | "screen";

export class CaptureError extends Error {}

// CaptureController (Chrome 109+) chưa có trong lib.dom của TypeScript
type CaptureControllerLike = {
  setFocusBehavior(behavior: "focus-captured-surface" | "no-focus-change"): void;
};
declare const CaptureController: { new (): CaptureControllerLike } | undefined;

// Các option dưới đây chưa có trong lib.dom của TypeScript
type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  controller?: CaptureControllerLike;
};

const RAW_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * Phải gọi trực tiếp trong click handler (trình duyệt yêu cầu user gesture).
 * - tab: chọn 1 tab Meet / Zoom web / Teams web, tick "Chia sẻ âm thanh tab"
 * - screen: chia sẻ toàn màn hình + "Chia sẻ âm thanh hệ thống" để bắt Zoom/Teams app
 */
export async function getMeetingStream(mode: CaptureMode): Promise<MediaStream> {
  const options: ExtendedDisplayMediaOptions =
    mode === "tab"
      ? {
          video: { displaySurface: "browser" },
          audio: RAW_AUDIO,
          selfBrowserSurface: "exclude",
          systemAudio: "exclude",
          surfaceSwitching: "include",
        }
      : {
          video: { displaySurface: "monitor" },
          audio: RAW_AUDIO,
          systemAudio: "include",
          monitorTypeSurfaces: "include",
        };

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError("Trình duyệt này không hỗ trợ ghi âm thanh cuộc họp. Hãy dùng Chrome hoặc Edge trên máy tính.");
  }

  // Mặc định Chrome nhảy sang tab vừa chọn; controller giúp giữ người dùng ở lại MeetScribe
  const controller = typeof CaptureController !== "undefined" ? new CaptureController() : undefined;

  let stream: MediaStream;
  try {
    const request: ExtendedDisplayMediaOptions = { ...options, controller };
    stream = await navigator.mediaDevices.getDisplayMedia(request);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new CaptureError(
        "Chưa chia sẻ được: bạn đã huỷ, hoặc trình duyệt đang chặn quyền chia sẻ màn hình. Bấm lại và chọn nguồn cuộc họp.",
      );
    }
    throw err;
  }

  // Chia sẻ tab/cửa sổ: ở lại MeetScribe để thấy transcript (với "toàn màn hình" thì API ném lỗi, bỏ qua)
  try {
    controller?.setFocusBehavior("no-focus-change");
  } catch {
    // monitor: không có gì để chuyển focus
  }

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError(
      mode === "tab"
        ? 'Không có âm thanh. Khi chọn tab, nhớ bật "Chia sẻ âm thanh tab".'
        : 'Không có âm thanh. Khi chọn "Toàn màn hình", nhớ bật "Chia sẻ âm thanh hệ thống".',
    );
  }
  return stream;
}

export async function getMicStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new CaptureError("Không mở được micro. Kiểm tra quyền micro của trình duyệt.");
  }
}

export type AudioMeter = {
  /** Mức âm lượng 0..1 để hiển thị meter */
  getLevel: () => number;
  /** Đăng ký callback khi người dùng bấm "Dừng chia sẻ" của trình duyệt */
  onSourceEnded: (cb: () => void) => void;
  stop: () => void;
};

/** Đo mức âm của các nguồn (để người dùng thấy ngay nếu quên tick chia sẻ âm thanh). */
export function createMeter(streams: MediaStream[]): AudioMeter {
  const ctx = new AudioContext();
  // Trang đã có click của người dùng nên resume được
  void ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  for (const s of streams) ctx.createMediaStreamSource(s).connect(analyser);

  const buffer = new Uint8Array(analyser.fftSize);
  const endedCallbacks: (() => void)[] = [];
  for (const track of streams.flatMap((s) => s.getTracks())) {
    track.addEventListener("ended", () => endedCallbacks.forEach((cb) => cb()));
  }

  return {
    getLevel() {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const v of buffer) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 64);
    },
    onSourceEnded(cb) {
      endedCallbacks.push(cb);
    },
    stop() {
      void ctx.close();
    },
  };
}

/** Trộn nhiều nguồn thành 1 stream (cho engine chỉ nhận 1 kênh như Soniox Web SDK). */
export function mixToStream(streams: MediaStream[]) {
  const ctx = new AudioContext();
  void ctx.resume();
  const destination = ctx.createMediaStreamDestination();
  for (const s of streams) ctx.createMediaStreamSource(s).connect(destination);
  return {
    stream: destination.stream,
    close() {
      destination.stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

export function stopStreams(streams: (MediaStream | null)[]) {
  for (const s of streams) s?.getTracks().forEach((t) => t.stop());
}
