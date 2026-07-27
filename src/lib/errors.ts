import { logEvent } from "@/lib/observability";
import { AppError } from "@/lib/appError";

export { AppError } from "@/lib/appError";

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
