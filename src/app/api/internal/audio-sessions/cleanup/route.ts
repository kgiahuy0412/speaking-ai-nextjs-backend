import { cleanupExpiredAudioSessions } from "@/lib/storage/audioSessions";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return (
    process.env.NODE_ENV !== "production" ||
    Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`)
  );
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);

  if (!isAuthorized(request)) {
    return withRequestId(
      Response.json(
        { error: { code: "UNAUTHORIZED", message: "Không có quyền truy cập." } },
        { status: 401 },
      ),
      requestId,
    );
  }

  const deletedCount = await cleanupExpiredAudioSessions(true);
  logEvent("info", "audio_session_cleanup_completed", {
    requestId,
    deletedCount,
  });
  return withRequestId(Response.json({ deletedCount }), requestId);
}
