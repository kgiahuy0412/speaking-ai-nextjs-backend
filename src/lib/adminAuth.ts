import "server-only";

import { timingSafeEqual } from "node:crypto";

function configuredAdminToken() {
  return process.env.ADMIN_API_TOKEN?.trim() || null;
}

export function getAdminSecurityMode() {
  if (configuredAdminToken()) {
    return "admin-token" as const;
  }

  return process.env.NODE_ENV === "production"
    ? ("not-configured" as const)
    : ("local-development" as const);
}

function safeTokenEquals(candidate: string, expected: string) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);

  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

export function requireAdminAccess(request: Request) {
  const expected = configuredAdminToken();

  if (!expected && process.env.NODE_ENV !== "production") {
    return null;
  }

  if (!expected) {
    return Response.json(
      {
        error: {
          code: "ADMIN_NOT_CONFIGURED",
          message: "Chưa cấu hình ADMIN_API_TOKEN cho môi trường production.",
        },
      },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const candidate =
    request.headers.get("x-admin-token")?.trim() || bearerToken;

  if (!candidate || !safeTokenEquals(candidate, expected)) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Mã quản trị không hợp lệ.",
        },
      },
      { status: 401 },
    );
  }

  return null;
}
