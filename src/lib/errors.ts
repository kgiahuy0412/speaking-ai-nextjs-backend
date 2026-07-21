import type { ApiErrorCode } from "@/types/conversation";
import { logEvent } from "@/lib/observability";

export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorResponse(error: unknown, requestId?: string) {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message, requestId } },
      { status: error.status },
    );
  }

  logEvent("error", "unhandled_api_error", { requestId, error });

  return Response.json(
    {
      error: {
        code: "BAD_REQUEST",
        message: "Có lỗi xảy ra. Vui lòng thử lại.",
        requestId,
      },
    },
    { status: 500 },
  );
}
