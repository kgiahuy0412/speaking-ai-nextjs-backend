import { createAudioUploadSession } from "@/lib/storage/audioSessions";
import { getAudioUploadLimits } from "@/lib/storage/config";
import { getRequestId, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const limits = getAudioUploadLimits();
  return withRequestId(
    Response.json({
      audioSessionId: await createAudioUploadSession(),
      capabilities: {
        pcm16WavFinalize: true,
        maxChunkBytes: limits.maxChunkBytes,
        maxSessionBytes: limits.maxSessionBytes,
        maxChunks: limits.maxChunks,
      },
    }),
    requestId,
  );
}
