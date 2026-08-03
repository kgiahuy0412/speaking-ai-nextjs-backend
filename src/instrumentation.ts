type AudioCleanupGlobal = typeof globalThis & {
  __aiSpeakingAudioCleanupTimer?: ReturnType<typeof setInterval>;
};

const cleanupGlobal = globalThis as AudioCleanupGlobal;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || cleanupGlobal.__aiSpeakingAudioCleanupTimer) {
    return;
  }

  const [{ cleanupExpiredAudioSessions }, { getAudioUploadLimits }, { logEvent }] =
    await Promise.all([
      import("@/lib/storage/audioSessions"),
      import("@/lib/storage/config"),
      import("@/lib/observability"),
    ]);
  const cleanup = () =>
    cleanupExpiredAudioSessions(true)
      .then((deletedCount) => {
        if (deletedCount > 0) {
          logEvent("info", "audio_session_background_cleanup_completed", {
            deletedCount,
          });
        }
      })
      .catch((error) => {
        logEvent("error", "audio_session_background_cleanup_failed", { error });
      });

  await cleanup();
  const intervalMs = getAudioUploadLimits().cleanupIntervalSeconds * 1_000;
  const timer = setInterval(cleanup, intervalMs);
  timer.unref();
  cleanupGlobal.__aiSpeakingAudioCleanupTimer = timer;
}
