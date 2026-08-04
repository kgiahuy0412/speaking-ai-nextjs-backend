import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

/**
 * OpenAI Realtime is intentionally unavailable. The application is
 * Cloudflare-only; clients must use the normal conversation or chunk routes.
 */
export async function POST(request: Request) {
  const requestId = getRequestId(request);

  logEvent("warn", "realtime_transcription_session_rejected", {
    requestId,
    reason: "cloudflare_only",
  });

  return withRequestId(
    Response.json(
      {
        error: {
          code: "ASR_MODE_DISABLED",
          message:
            "Che do Realtime da bi tat. Hay dung Cloudflare Batch Chunks.",
          requestId,
        },
      },
      { status: 410 },
    ),
    requestId,
  );
}
