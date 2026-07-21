import "server-only";

import { randomUUID } from "node:crypto";

type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const requestIdPattern = /^[a-zA-Z0-9._:-]{8,100}$/;

export function getRequestId(request: Request) {
  const candidate = request.headers.get("x-request-id")?.trim() ?? "";
  return requestIdPattern.test(candidate) ? candidate : randomUUID();
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return {
    name: error.name,
    message: error.message,
  };
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        value instanceof Error ? serializeError(value) : value,
      ]),
    ),
  });

  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}

export function withRequestId(response: Response, requestId: string) {
  response.headers.set("X-Request-Id", requestId);
  return response;
}
