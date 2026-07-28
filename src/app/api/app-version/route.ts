import {
  AppVersionPolicyConfigurationError,
  getAndroidAppVersionPolicy,
} from "@/lib/appVersionPolicy";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const platform = (url.searchParams.get("platform") ?? "android").trim();
  const channel = (url.searchParams.get("channel") ?? "direct").trim();

  if (platform !== "android" || channel !== "direct") {
    return withRequestId(
      Response.json(
        {
          error: {
            code: "UNSUPPORTED_UPDATE_CHANNEL",
            message: "Kênh cập nhật ứng dụng không được hỗ trợ.",
            requestId,
          },
        },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      ),
      requestId,
    );
  }

  try {
    const policy = getAndroidAppVersionPolicy();
    return withRequestId(
      Response.json(
        {
          ...policy,
          checkedAt: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
      requestId,
    );
  } catch (error) {
    logEvent("error", "android_app_version_policy_failed", {
      requestId,
      error,
    });
    const configurationError =
      error instanceof AppVersionPolicyConfigurationError;
    return withRequestId(
      Response.json(
        {
          error: {
            code: configurationError
              ? "UPDATE_POLICY_NOT_CONFIGURED"
              : "INTERNAL_ERROR",
            message: "Chưa lấy được chính sách cập nhật ứng dụng.",
            requestId,
          },
        },
        {
          status: configurationError ? 503 : 500,
          headers: { "Cache-Control": "no-store" },
        },
      ),
      requestId,
    );
  }
}
