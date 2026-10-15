import { createTemporaryKey, REALTIME_MODEL } from "@/lib/server/soniox";

export async function POST() {
  try {
    const apiKey = await createTemporaryKey();
    return Response.json({ apiKey, model: REALTIME_MODEL });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
