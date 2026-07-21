import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const requestIdPattern = /^[a-zA-Z0-9._:-]{8,100}$/;

export function proxy(request: NextRequest) {
  const incomingRequestId = request.headers.get("x-request-id")?.trim() ?? "";
  const requestId = requestIdPattern.test(incomingRequestId)
    ? incomingRequestId
    : crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
