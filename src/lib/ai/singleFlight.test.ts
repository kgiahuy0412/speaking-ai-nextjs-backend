import assert from "node:assert/strict";
import test from "node:test";
import { claimSingleFlight } from "./singleFlight";

test("concurrent identical operations join one provider request", async () => {
  const flights = new Map<string, Promise<string>>();
  let providerCalls = 0;
  const operation = async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "shared result";
  };

  const owner = claimSingleFlight({ flights, key: "same", operation });
  const joined = claimSingleFlight({ flights, key: "same", operation });

  assert.equal(owner.joined, false);
  assert.equal(joined.joined, true);
  assert.deepEqual(
    await Promise.all([owner.promise, joined.promise]),
    ["shared result", "shared result"],
  );
  assert.equal(providerCalls, 1);
});
