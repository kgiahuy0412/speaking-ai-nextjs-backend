import { requireAdminAccess } from "@/lib/adminAuth";
import { getStorageHealth } from "@/lib/storage/health";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const unauthorized = requireAdminAccess(request);

  if (unauthorized) {
    return withRequestId(unauthorized, requestId);
  }

  try {
    const health = await getStorageHealth();
    logEvent("info", "storage_health_checked", {
      requestId,
      ok: health.ok,
      persistenceBackend: health.configuration.persistenceBackend,
      audioStorageBackend: health.configuration.audioStorageBackend,
    });
    return withRequestId(Response.json(health), requestId);
  } catch (error) {
    logEvent("error", "storage_health_check_failed", { requestId, error });
    return withRequestId(
      Response.json(
        {
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Không thể kết nối hệ thống lưu trữ.",
            requestId,
          },
        },
        { status: 503 },
      ),
      requestId,
    );
  }
}
