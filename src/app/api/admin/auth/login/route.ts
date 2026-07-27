import { adminCredentialsMatch } from "@/lib/adminAuthCore";
import {
  getConfiguredAdminCredentials,
  setAdminSessionCookie,
} from "@/lib/adminAuth";

const LOGIN_FAILURE_DELAY_MS = 350;

function invalidCredentialsResponse() {
  return Response.json(
    {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Tài khoản hoặc mật khẩu không đúng.",
      },
    },
    { status: 401 },
  );
}

export async function POST(request: Request) {
  const configuredCredentials = getConfiguredAdminCredentials();
  if (!configuredCredentials) {
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

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) {
    return invalidCredentialsResponse();
  }

  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    password?: unknown;
  } | null;
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (
    username.length > 256 ||
    password.length > 1024 ||
    !adminCredentialsMatch(
      { username, password },
      configuredCredentials,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_FAILURE_DELAY_MS));
    return invalidCredentialsResponse();
  }

  await setAdminSessionCookie(configuredCredentials);

  return Response.json({ success: true });
}
