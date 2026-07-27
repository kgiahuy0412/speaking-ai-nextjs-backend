import "server-only";

import { cookies } from "next/headers";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionToken,
  verifyAdminSessionToken,
  type AdminCredentials,
} from "@/lib/adminAuthCore";

export const ADMIN_SESSION_COOKIE = "ai-speaking-admin-session";

export function getConfiguredAdminCredentials(): AdminCredentials | null {
  const username = process.env.ADMIN_USERNAME?.trim() ?? "";
  const password = process.env.ADMIN_PASSWORD ?? "";

  return username && password ? { username, password } : null;
}

export function getAdminSecurityMode() {
  return getConfiguredAdminCredentials()
    ? ("account-password" as const)
    : ("not-configured" as const);
}

function requestCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") ?? "";

  for (const cookie of cookieHeader.split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const cookieName = cookie.slice(0, separatorIndex).trim();
    if (cookieName === name) {
      return cookie.slice(separatorIndex + 1).trim();
    }
  }

  return null;
}

export async function hasValidAdminSession() {
  // Read the request cookie before checking environment configuration so that
  // Next.js always treats admin pages as request-time dynamic routes.
  const cookieStore = await cookies();
  const credentials = getConfiguredAdminCredentials();
  if (!credentials) {
    return false;
  }

  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? "";

  return verifyAdminSessionToken(token, credentials);
}

export async function setAdminSessionCookie(credentials: AdminCredentials) {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_SESSION_COOKIE,
    value: createAdminSessionToken(credentials),
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearAdminSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function requireAdminAccess(request: Request) {
  const credentials = getConfiguredAdminCredentials();

  if (!credentials) {
    return Response.json(
      {
        error: {
          code: "ADMIN_NOT_CONFIGURED",
          message:
            "Chưa cấu hình ADMIN_USERNAME và ADMIN_PASSWORD trên máy chủ.",
        },
      },
      { status: 503 },
    );
  }

  const token = requestCookie(request, ADMIN_SESSION_COOKIE) ?? "";
  if (!verifyAdminSessionToken(token, credentials)) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Phiên đăng nhập quản trị không hợp lệ hoặc đã hết hạn.",
        },
      },
      { status: 401 },
    );
  }

  return null;
}
