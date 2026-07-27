import assert from "node:assert/strict";
import test from "node:test";
import {
  DeviceRegistrationValidationError,
  parseAndroidDeviceRegistration,
} from "./deviceRegistration";

const validPayload = {
  clientId: "android_7396019906ad3574",
  device: {
    manufacturer: "samsung",
    brand: "samsung",
    model: "SM-S918B",
    androidVersion: "14",
    sdkInt: 34,
    supportedAbis: ["arm64-v8a", "armeabi-v7a"],
    socManufacturer: "Qualcomm",
    socModel: "SM8550",
    totalRamBytes: 12_884_901_888,
    availableRamBytes: 5_368_709_120,
    totalStorageBytes: 256_000_000_000,
    availableStorageBytes: 74_000_000_000,
  },
};

test("parses an Android hardware registration", () => {
  const parsed = parseAndroidDeviceRegistration(validPayload);

  assert.equal(parsed.clientId, validPayload.clientId);
  assert.equal(parsed.hardware.model, "SM-S918B");
  assert.deepEqual(parsed.hardware.supportedAbis, [
    "arm64-v8a",
    "armeabi-v7a",
  ]);
});

test("rejects impossible available memory values", () => {
  assert.throws(
    () =>
      parseAndroidDeviceRegistration({
        ...validPayload,
        device: {
          ...validPayload.device,
          availableRamBytes: validPayload.device.totalRamBytes + 1,
        },
      }),
    DeviceRegistrationValidationError,
  );
});

test("rejects non-Android client identifiers", () => {
  assert.throws(
    () =>
      parseAndroidDeviceRegistration({
        ...validPayload,
        clientId: "browser-device",
      }),
    DeviceRegistrationValidationError,
  );
});
