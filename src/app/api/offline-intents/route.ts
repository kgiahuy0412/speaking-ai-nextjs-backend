import { getOfflineIntentManifest } from "@/lib/ai/offlineIntentManifest";
import { toErrorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 40);
    const manifest = await getOfflineIntentManifest(
      Number.isFinite(requestedLimit) ? requestedLimit : 40,
    );

    return Response.json(manifest, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
