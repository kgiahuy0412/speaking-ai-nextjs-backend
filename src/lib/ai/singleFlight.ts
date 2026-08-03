export type SingleFlightClaim<T> = {
  joined: boolean;
  promise: Promise<T>;
};

export function claimSingleFlight<Key, Value>(input: {
  flights: Map<Key, Promise<Value>>;
  key: Key;
  operation: () => Promise<Value>;
  retainForMs?: number;
}): SingleFlightClaim<Value> {
  const active = input.flights.get(input.key);
  if (active) {
    return { joined: true, promise: active };
  }

  const promise = Promise.resolve().then(input.operation);
  input.flights.set(input.key, promise);
  const clear = () => {
    if (input.flights.get(input.key) === promise) {
      input.flights.delete(input.key);
    }
  };

  void promise.then(
    () => {
      if ((input.retainForMs ?? 0) <= 0) {
        clear();
        return;
      }
      const timer = setTimeout(clear, input.retainForMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    },
    clear,
  );

  return { joined: false, promise };
}
