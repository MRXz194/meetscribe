"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AppWindowIcon,
  CircleCheckIcon,
  Loader2Icon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PictureInPicture2Icon,
  ServerOffIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TranscriptView } from "@/components/transcript-view";
import { FloatingTranscript } from "@/components/floating-transcript";
import { useLiveTranscript } from "@/hooks/useLiveTranscript";
import { useEngine } from "@/hooks/useEngine";
import { useDeepgramLanguage } from "@/hooks/useDeepgramLanguage";
import { useAsrHealth } from "@/hooks/useAsrHealth";
import { useDocumentPip } from "@/hooks/useDocumentPip";
import { buildSegments, defaultSpeakerName, formatClock } from "@/lib/transcript";
import { DEEPGRAM_LANGUAGES, ENGINES, VIA_ASR_SERVER, type DeepgramLanguage, type EngineId } from "@/lib/transcriber/types";
import type { CaptureMode } from "@/lib/audio/sources";
import type { Meeting, TranscriptToken } from "@/lib/types";
import { cn } from "@/lib/utils";

const SOURCES: { mode: CaptureMode; title: string; desc: string; hint: string; icon: typeof MonitorIcon }[] = [
  {
    mode: "tab",
    title: "Cuộc họp trên trình duyệt",
    desc: "Google Meet, Zoom web, Teams web…",
    hint: 'Chọn tab cuộc họp và bật "Chia sẻ âm thanh tab".',
    icon: AppWindowIcon,
  },
  {
    mode: "screen",
    title: "App họp trên máy",
    desc: "Zoom, Teams, Discord bản desktop…",
    hint: 'Chọn "Toàn màn hình" và bật "Chia sẻ âm thanh hệ thống".',
    icon: MonitorIcon,
  },
];

const nameOf = defaultSpeakerName;

function defaultTitle() {
  const d = new Date();
  return `Cuộc họp ${d.toLocaleDateString("vi-VN")} ${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`;
}

export function Recorder() {
  const router = useRouter();
  const pip = useDocumentPip();
  const live = useLiveTranscript({
    // Phiên kết thúc theo bất kỳ cách nào (nút Dừng, thanh "Dừng chia sẻ" của trình duyệt) đều được lưu
    onComplete: (tokens) => {
      pip.close();
      void save(tokens);
    },
  });
  const [mode, setMode] = useState<CaptureMode>("tab");
  const [withMic, setWithMic] = useState(true);
  const [engine, setEngine] = useEngine();
  const [language, setLanguage] = useDeepgramLanguage();
  const viaAsr = VIA_ASR_SERVER.includes(engine);
  const health = useAsrHealth(viaAsr);
  const deepgramMissing = engine === "deepgram" && health.state === "ok" && !health.deepgram;
  const asrReady = !viaAsr || (health.state === "ok" && !deepgramMissing);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Tiêu đề mặc định theo giờ hiện tại; đặt sau khi mount để tránh lệch giờ server/client
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setTitle(defaultTitle()), []);

  const segments = useMemo(() => buildSegments(live.finalTokens), [live.finalTokens]);
  const partials = useMemo(
    () =>
      buildSegments(
        live.partialTokens.map((t) => ({ ...t, speaker: t.speaker ?? segments.at(-1)?.speaker ?? "1" })),
      ).map((s) => ({ speaker: s.speaker, text: s.text })),
    [live.partialTokens, segments],
  );

  // Tự cuộn xuống cuối khi có chữ mới, trừ khi người dùng đang cuộn lên đọc lại
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [segments, partials]);

  const active = live.status === "starting" || live.status === "recording" || live.status === "stopping";

  async function save(tokens: TranscriptToken[]) {
    const finalSegments = buildSegments(tokens);
    if (!finalSegments.length) {
      toast.warning("Không nhận được lời nói nào, chưa lưu cuộc họp.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || defaultTitle(),
          source: mode,
          durationSec: Math.round(live.elapsedMs / 1000),
          segments: finalSegments,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Lưu thất bại");
      const meeting = (await res.json()) as Meeting;
      router.push(`/meetings/${meeting.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setSaving(false);
    }
  }

  function handleStop() {
    // Lưu được làm trong onComplete để cả "Dừng chia sẻ" của trình duyệt cũng lưu
    void live.stop();
  }

  const current = SOURCES.find((s) => s.mode === mode)!;

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Ghi cuộc họp</CardTitle>
            <CardDescription>Không cần bot vào phòng: audio lấy ngay trên máy bạn.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="title" className="text-sm font-medium">
                Tiêu đề
              </label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium">Nguồn cuộc họp</span>
              {SOURCES.map((s) => (
                <button
                  key={s.mode}
                  type="button"
                  disabled={active}
                  onClick={() => setMode(s.mode)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
                    mode === s.mode ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted",
                  )}
                >
                  <s.icon className="mt-0.5 size-5 shrink-0 text-primary" />
                  <span>
                    <span className="block text-sm font-medium">{s.title}</span>
                    <span className="block text-xs text-muted-foreground">{s.desc}</span>
                  </span>
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={active}
              onClick={() => setWithMic((v) => !v)}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm hover:bg-muted disabled:opacity-60"
            >
              {withMic ? <MicIcon className="size-5 text-primary" /> : <MicOffIcon className="size-5 text-muted-foreground" />}
              <span className="flex-1">
                <span className="block font-medium">{withMic ? "Ghi cả giọng của tôi" : "Không ghi giọng của tôi"}</span>
                <span className="block text-xs text-muted-foreground">
                  {viaAsr
                    ? "Micro là kênh riêng, câu nào của bạn được ghi chắc chắn là “Tôi”"
                    : "Trộn micro vào để transcript có cả phần bạn nói"}
                </span>
              </span>
              <span className={cn("h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors", withMic ? "bg-primary" : "bg-muted")}>
                <span className={cn("block size-4 rounded-full bg-background shadow transition-transform", withMic && "translate-x-4")} />
              </span>
            </button>

            <div className="space-y-2">
              <span className="text-sm font-medium">Engine nhận dạng</span>
              <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
                {(Object.keys(ENGINES) as EngineId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={active}
                    onClick={() => setEngine(id)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                      engine === id ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                  >
                    {ENGINES[id].label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{ENGINES[engine].desc}</p>
              {engine === "deepgram" && (
                <div className="space-y-1">
                  <div className="grid grid-cols-3 gap-1 rounded-lg border p-1" role="radiogroup" aria-label="Ngôn ngữ Deepgram">
                    {(Object.keys(DEEPGRAM_LANGUAGES) as DeepgramLanguage[]).map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={language === id}
                        disabled={active}
                        onClick={() => setLanguage(id)}
                        className={cn(
                          "rounded-md px-1.5 py-1 text-xs font-medium transition-colors disabled:opacity-60",
                          language === id ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        )}
                      >
                        {DEEPGRAM_LANGUAGES[id].label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{DEEPGRAM_LANGUAGES[language].desc}</p>
                </div>
              )}
              {viaAsr &&
                (deepgramMissing ? (
                  <div className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
                    <p className="flex items-center gap-1.5 font-medium text-destructive">
                      <TriangleAlertIcon className="size-3.5" /> Chưa có key Deepgram
                    </p>
                    <p className="text-muted-foreground">
                      Điền <code className="rounded bg-muted px-1">DEEPGRAM_API_KEY</code> vào{" "}
                      <code>meetscribe/.env.local</code>. ASR server tự đọc lại, không cần khởi động lại.
                    </p>
                  </div>
                ) : health.state === "ok" ? (
                  <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <CircleCheckIcon className="size-3.5" />
                    {engine === "deepgram" ? "ASR server + Deepgram sẵn sàng" : "ASR server sẵn sàng"}
                  </p>
                ) : health.state === "checking" ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" /> Đang kiểm tra ASR server…
                  </p>
                ) : (
                  <div className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
                    <p className="flex items-center gap-1.5 font-medium text-destructive">
                      <ServerOffIcon className="size-3.5" /> ASR server chưa chạy
                    </p>
                    <p className="text-muted-foreground">
                      Mở terminal trong thư mục <code>meetscribe</code> và chạy{" "}
                      <code className="rounded bg-muted px-1">npm run dev:all</code> (bật cả web lẫn ASR server). Trang tự
                      nhận khi server lên.
                    </p>
                  </div>
                ))}
            </div>

            {!active ? (
              <Button
                size="lg"
                className="w-full"
                disabled={saving || live.status === "starting" || !asrReady}
                onClick={() => live.start({ mode, withMic, engine, language })}
              >
                {saving ? <Loader2Icon className="animate-spin" /> : <span className="size-2 rounded-full bg-red-500" />}
                {saving ? "Đang lưu…" : "Bắt đầu ghi"}
              </Button>
            ) : (
              <Button
                size="lg"
                variant="destructive"
                className="w-full"
                disabled={live.status !== "recording"}
                onClick={handleStop}
              >
                {live.status === "recording" ? <SquareIcon className="fill-current" /> : <Loader2Icon className="animate-spin" />}
                {live.status === "starting" ? "Đang kết nối…" : live.status === "stopping" ? "Đang chốt kết quả…" : "Dừng & lưu"}
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              Mẹo: {current.hint} Dùng tai nghe để micro không thu lại tiếng loa.
            </p>
          </CardContent>
        </Card>

        {live.warning && live.status === "recording" && (
          <Card className="border-amber-500/40">
            <CardContent className="flex gap-3 text-sm">
              <TriangleAlertIcon className="size-5 shrink-0 text-amber-500" />
              <p>{live.warning}</p>
            </CardContent>
          </Card>
        )}

        {live.notice && (
          <Card className="border-amber-500/40">
            <CardContent className="flex gap-3 text-sm">
              <Loader2Icon className="size-5 shrink-0 animate-spin text-amber-500" />
              <p>{live.notice}</p>
            </CardContent>
          </Card>
        )}

        {live.error && (
          <Card className="border-destructive/40">
            <CardContent className="flex gap-3 text-sm">
              <TriangleAlertIcon className="size-5 shrink-0 text-destructive" />
              <div className="space-y-2">
                <p>{live.error}</p>
                {live.finalTokens.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => save(live.finalTokens)} disabled={saving}>
                    Lưu phần đã ghi được
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="flex min-h-[70vh] flex-col">
        <CardHeader className="flex flex-row items-center gap-3 border-b">
          <CardTitle className="flex items-center gap-2">
            {live.status === "recording" && <span className="size-2.5 animate-pulse rounded-full bg-red-500" />}
            Transcript trực tiếp
          </CardTitle>
          <div className="ml-auto flex items-center gap-3">
            {live.status === "recording" && pip.supported && !pip.pipWindow && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  pip.open().catch(() => toast.error("Trình duyệt không mở được cửa sổ nổi. Hãy dùng Chrome hoặc Edge bản mới."))
                }
              >
                <PictureInPicture2Icon /> Cửa sổ nổi
              </Button>
            )}
            {live.status === "recording" && (
              <div className="flex h-4 items-end gap-0.5" aria-label="Mức âm thanh">
                {[0.15, 0.35, 0.55, 0.75, 0.9].map((t) => (
                  <span
                    key={t}
                    className={cn("w-1 rounded-sm transition-colors", live.level > t ? "bg-emerald-500" : "bg-muted")}
                    style={{ height: `${t * 100}%` }}
                  />
                ))}
              </div>
            )}
            <Badge variant="secondary" className="font-mono tabular-nums">
              {formatClock(live.elapsedMs)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent ref={scrollRef} className="flex-1 overflow-y-auto py-4" style={{ maxHeight: "70vh" }}>
          {segments.length === 0 && partials.length === 0 ? (
            <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              {live.status === "recording" ? (
                <>
                  <Loader2Icon className="size-5 animate-spin" />
                  Đang nghe… chữ sẽ hiện ngay khi có người nói.
                  {pip.supported && (
                    <span className="max-w-sm text-xs">
                      Mẹo: bấm “Cửa sổ nổi” để xem transcript ngay trên cuộc họp, không cần chuyển tab.
                    </span>
                  )}
                </>
              ) : (
                <>
                  <current.icon className="size-8" />
                  Chọn nguồn bên trái rồi bấm “Bắt đầu ghi”.
                </>
              )}
            </div>
          ) : (
            <TranscriptView segments={segments} partials={partials} nameOf={nameOf} />
          )}
        </CardContent>
      </Card>

      {pip.pipWindow && (
        <FloatingTranscript
          pipWindow={pip.pipWindow}
          segments={segments}
          partials={partials}
          nameOf={nameOf}
          elapsedMs={live.elapsedMs}
          recording={live.status === "recording"}
        />
      )}
    </div>
  );
}
