import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function apiRequest(
  url: string,
  headers: Record<string, string>,
  method = "POST",
) {
  return new NextRequest(url, { method, headers });
}

function restoreAllowedOrigins(previousValue: string | undefined) {
  if (previousValue === undefined) {
    delete process.env.PWA_ALLOWED_ORIGINS;
  } else {
    process.env.PWA_ALLOWED_ORIGINS = previousValue;
  }
}

test("allows a same-origin admin login request in production", () => {
  const previousAllowedOrigins = process.env.PWA_ALLOWED_ORIGINS;
  process.env.PWA_ALLOWED_ORIGINS = "";

  try {
    const response = proxy(
      apiRequest("https://admin.example.com/api/admin/auth/login", {
        origin: "https://admin.example.com",
        "sec-fetch-site": "same-origin",
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    restoreAllowedOrigins(previousAllowedOrigins);
  }
});

test("recognizes the public same origin behind a reverse proxy", () => {
  const previousAllowedOrigins = process.env.PWA_ALLOWED_ORIGINS;
  process.env.PWA_ALLOWED_ORIGINS = "";

  try {
    const response = proxy(
      apiRequest("http://localhost:3000/api/admin/auth/login", {
        origin: "https://admin.example.com",
        "x-forwarded-host": "admin.example.com",
        "x-forwarded-proto": "https",
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  } finally {
    restoreAllowedOrigins(previousAllowedOrigins);
  }
});

test("continues to reject an unconfigured cross-origin request", async () => {
  const previousAllowedOrigins = process.env.PWA_ALLOWED_ORIGINS;
  process.env.PWA_ALLOWED_ORIGINS = "";

  try {
    const response = proxy(
      apiRequest("https://admin.example.com/api/admin/auth/login", {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      }),
    );

    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).error.code,
      "ORIGIN_NOT_ALLOWED",
    );
  } finally {
    restoreAllowedOrigins(previousAllowedOrigins);
  }
});

test("allows a configured external PWA origin", () => {
  const previousAllowedOrigins = process.env.PWA_ALLOWED_ORIGINS;
  process.env.PWA_ALLOWED_ORIGINS = "https://pwa.example/";

  try {
    const response = proxy(
      apiRequest("https://api.example.com/api/conversation", {
        origin: "https://pwa.example",
        "sec-fetch-site": "cross-site",
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://pwa.example",
    );
  } finally {
    restoreAllowedOrigins(previousAllowedOrigins);
  }
});
