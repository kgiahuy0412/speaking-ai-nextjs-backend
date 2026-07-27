import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const requestIdPattern = /^[a-zA-Z0-9._:-]{8,100}$/;
const developmentOriginPattern =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Request-Id, Idempotency-Key, Authorization, Range",
  "Access-Control-Expose-Headers":
    "X-Request-Id, X-Audio-Source, Accept-Ranges, Content-Length, Content-Range",
  "Access-Control-Max-Age": "600",
} as const;

function configuredPwaOrigins() {
  return new Set(
    (process.env.PWA_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isAllowedOrigin(origin: string) {
  if (configuredPwaOrigins().has(origin)) {
    return true;
  }
  return process.env.NODE_ENV !== "production" &&
    developmentOriginPattern.test(origin);
}

function applyCorsHeaders(response: NextResponse, origin: string) {
  response.headers.set("Vary", "Origin");
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export function proxy(request: NextRequest) {
  const incomingRequestId = request.headers.get("x-request-id")?.trim() ?? "";
  const requestId = requestIdPattern.test(incomingRequestId)
    ? incomingRequestId
    : crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  const origin = request.headers.get("origin")?.trim() ?? "";

  if (origin && !isAllowedOrigin(origin)) {
    const deniedResponse = NextResponse.json(
      {
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Nguồn PWA chưa được máy chủ cho phép.",
          requestId,
        },
      },
      { status: 403 },
    );
    deniedResponse.headers.set("X-Request-Id", requestId);
    return applyCorsHeaders(
      deniedResponse,
      origin,
    );
  }

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("X-Request-Id", requestId);
    return applyCorsHeaders(response, origin);
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("X-Request-Id", requestId);
  return applyCorsHeaders(response, origin);
}

export const config = {
  matcher: "/api/:path*",
};
