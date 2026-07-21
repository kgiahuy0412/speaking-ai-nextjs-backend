import {
  AudioUploadError,
  discardAudioUploadSession,
  saveAudioSessionChunk,
} from "@/lib/storage/audioSessions";
import { getAudioUploadLimits } from "@/lib/storage/config";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ audioSessionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { audioSessionId } = await context.params;

  try {
    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes =
      getAudioUploadLimits().maxChunkBytes + 256 * 1024;

    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      throw new AudioUploadError(
        "CHUNK_TOO_LARGE",
        "Audio chunk vượt quá dung lượng cho phép.",
        413,
      );
    }

    const formData = await request.formData();
    const chunk = formData.get("audio");
    const sequence = Number(formData.get("sequence"));

    if (!(chunk instanceof File)) {
      throw new AudioUploadError(
        "EMPTY_CHUNK",
        "Audio chunk không hợp lệ.",
        400,
      );
    }

    const result = await saveAudioSessionChunk(audioSessionId, sequence, chunk);
    return withRequestId(
      Response.json({ uploaded: true, sequence, ...result }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "audio_chunk_upload_failed", {
      requestId,
      audioSessionId,
      error,
    });
    const status = error instanceof AudioUploadError ? error.status : 400;
    return withRequestId(
      Response.json(
        {
          error: {
            code:
              error instanceof AudioUploadError ? error.code : "BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "Không lưu được chunk.",
            requestId,
            ...(error instanceof AudioUploadError
              ? { details: error.details }
              : {}),
          },
        },
        { status },
      ),
      requestId,
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { audioSessionId } = await context.params;

  try {
    await discardAudioUploadSession(audioSessionId);
    return withRequestId(Response.json({ discarded: true }), requestId);
  } catch (error) {
    const status = error instanceof AudioUploadError ? error.status : 400;
    return withRequestId(
      Response.json(
        {
          error: {
            code:
              error instanceof AudioUploadError ? error.code : "BAD_REQUEST",
            message:
              error instanceof Error
                ? error.message
                : "Không xóa được audio session.",
            requestId,
          },
        },
        { status },
      ),
      requestId,
    );
  }
}
