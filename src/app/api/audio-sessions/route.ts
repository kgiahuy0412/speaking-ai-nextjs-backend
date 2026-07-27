import { createAudioUploadSession } from "@/lib/storage/audioSessions";
import { getRequestId, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  return withRequestId(
    Response.json({
      audioSessionId: await createAudioUploadSession(),
      capabilities: {
        pcm16WavFinalize: true,
      },
    }),
    requestId,
  );
}
