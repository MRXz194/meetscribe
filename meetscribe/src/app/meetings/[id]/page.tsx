import { Suspense } from "react";
import { Loader2Icon } from "lucide-react";
import { MeetingDetail } from "./meeting-detail";

export default function MeetingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20 text-muted-foreground">
          <Loader2Icon className="animate-spin" />
        </div>
      }
    >
      <MeetingDetail />
    </Suspense>
  );
}
