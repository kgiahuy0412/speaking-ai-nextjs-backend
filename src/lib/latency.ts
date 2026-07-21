export function nowMs() {
  return performance.now();
}

export async function measureStep<T>(step: () => Promise<T>) {
  const startedAt = nowMs();
  const value = await step();
  const endedAt = nowMs();

  return {
    value,
    latencyMs: Math.round(endedAt - startedAt),
  };
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
