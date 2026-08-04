import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const requestIdPattern = /^[a-zA-Z0-9._:-]{8,100}$/;
const developmentOriginPattern =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Request-Id, Idempotency-Key, X-Chunk-SHA256, X-Discard-Reason, Authorization, Range",
  "Access-Control-Expose-Headers":
    "X-Request-Id, X-Audio-Source, Retry-After, Accept-Ranges, Content-Length, Content-Range",
  "Access-Control-Max-Age": "600",
} as const;

function configuredPwaOrigins() {
  return new Set(
    (process.env.PWA_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => normalizedOrigin(origin))
      .filter(Boolean),
  );
}

function normalizedOrigin(value: string) {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return "";
  }
}

function firstForwardedValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

function isSameOriginRequest(request: NextRequest, origin: string) {
  const normalizedRequestOrigin = normalizedOrigin(origin);
  if (!normalizedRequestOrigin) {
    return false;
  }

  // Sec-Fetch-Site is controlled by the browser and remains reliable when a
  // reverse proxy exposes a public host that differs from Next.js' internal URL.
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin") {
    return true;
  }

  const requestOrigins = new Set([request.nextUrl.origin]);
  const forwardedHost = firstForwardedValue(
    request.headers.get("x-forwarded-host"),
  );
  const host = forwardedHost || request.headers.get("host")?.trim() || "";
  const forwardedProtocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto"),
  );
  const protocol =
    forwardedProtocol || request.nextUrl.protocol.replace(/:$/, "");

  if (host && (protocol === "http" || protocol === "https")) {
    requestOrigins.add(`${protocol}://${host}`);
  }

  return requestOrigins.has(normalizedRequestOrigin);
}

function isAllowedOrigin(request: NextRequest, origin: string) {
  const normalizedRequestOrigin = normalizedOrigin(origin);
  if (isSameOriginRequest(request, origin)) {
    return true;
  }

  if (configuredPwaOrigins().has(normalizedRequestOrigin)) {
    return true;
  }

  return process.env.NODE_ENV !== "production" &&
    developmentOriginPattern.test(normalizedRequestOrigin);
}

function applyCorsHeaders(
  response: NextResponse,
  request: NextRequest,
  origin: string,
) {
  response.headers.set("Vary", "Origin");
  if (origin && isAllowedOrigin(request, origin)) {
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

  if (origin && !isAllowedOrigin(request, origin)) {
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
      request,
      origin,
    );
  }

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("X-Request-Id", requestId);
    return applyCorsHeaders(response, request, origin);
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("X-Request-Id", requestId);
  return applyCorsHeaders(response, request, origin);
}

export const config = {
  matcher: "/api/:path*",
};
