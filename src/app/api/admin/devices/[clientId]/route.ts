import { requireAdminAccess } from "@/lib/adminAuth";
import { upsertDeviceProfile } from "@/lib/deviceProfiles";

export const runtime = "nodejs";

type DeviceRouteContext = {
  params: Promise<{ clientId: string }>;
};

export async function PATCH(request: Request, context: DeviceRouteContext) {
  const denied = requireAdminAccess(request);
  if (denied) {
    return denied;
  }

  const { clientId: rawClientId } = await context.params;
  const clientId = rawClientId.trim();
  const body = (await request.json().catch(() => null)) as {
    deviceName?: unknown;
    childName?: unknown;
  } | null;

  if (!clientId || clientId.length > 200 || !body) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Dữ liệu thiết bị không hợp lệ." } },
      { status: 400 },
    );
  }

  const deviceName =
    typeof body.deviceName === "string" ? body.deviceName.trim() : "";
  const childName =
    typeof body.childName === "string" ? body.childName.trim() : "";

  if (!deviceName || deviceName.length > 100 || childName.length > 100) {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Tên thiết bị là bắt buộc và không được dài quá 100 ký tự.",
        },
      },
      { status: 400 },
    );
  }

  return Response.json({
    device: await upsertDeviceProfile(clientId, { deviceName, childName }),
  });
}
