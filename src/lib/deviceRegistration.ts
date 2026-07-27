import type { AndroidDeviceHardware } from "@/types/admin";

export type AndroidDeviceRegistration = {
  clientId: string;
  hardware: Omit<AndroidDeviceHardware, "reportedAt">;
};

export class DeviceRegistrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceRegistrationValidationError";
  }
}

function asObject(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceRegistrationValidationError(message);
  }

  return value as Record<string, unknown>;
}

function requiredText(
  source: Record<string, unknown>,
  key: string,
  maxLength = 120,
) {
  const value = source[key];
  if (typeof value !== "string") {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  return normalized;
}

function optionalText(
  source: Record<string, unknown>,
  key: string,
  maxLength = 120,
) {
  const value = source[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  return normalized;
}

function positiveInteger(
  source: Record<string, unknown>,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = source[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  return value;
}

function nonNegativeInteger(
  source: Record<string, unknown>,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = source[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new DeviceRegistrationValidationError(`${key} không hợp lệ.`);
  }

  return value;
}

function supportedAbis(source: Record<string, unknown>) {
  const value = source.supportedAbis;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new DeviceRegistrationValidationError("supportedAbis không hợp lệ.");
  }

  const normalized = value.map((item) => {
    if (typeof item !== "string") {
      throw new DeviceRegistrationValidationError(
        "supportedAbis không hợp lệ.",
      );
    }

    const abi = item.trim();
    if (!abi || abi.length > 64) {
      throw new DeviceRegistrationValidationError(
        "supportedAbis không hợp lệ.",
      );
    }
    return abi;
  });

  return [...new Set(normalized)];
}

export function parseAndroidDeviceRegistration(
  value: unknown,
): AndroidDeviceRegistration {
  const body = asObject(value, "Dữ liệu đăng ký thiết bị không hợp lệ.");
  const clientId = requiredText(body, "clientId");
  if (!/^android_[A-Za-z0-9._:-]+$/.test(clientId)) {
    throw new DeviceRegistrationValidationError("clientId không hợp lệ.");
  }

  const device = asObject(
    body.device,
    "Thông tin phần cứng thiết bị không hợp lệ.",
  );
  const totalRamBytes = positiveInteger(device, "totalRamBytes");
  const availableRamBytes = nonNegativeInteger(device, "availableRamBytes");
  const totalStorageBytes = positiveInteger(device, "totalStorageBytes");
  const availableStorageBytes = nonNegativeInteger(
    device,
    "availableStorageBytes",
  );

  if (availableRamBytes > totalRamBytes) {
    throw new DeviceRegistrationValidationError(
      "availableRamBytes không được lớn hơn totalRamBytes.",
    );
  }
  if (availableStorageBytes > totalStorageBytes) {
    throw new DeviceRegistrationValidationError(
      "availableStorageBytes không được lớn hơn totalStorageBytes.",
    );
  }

  return {
    clientId,
    hardware: {
      manufacturer: requiredText(device, "manufacturer"),
      brand: requiredText(device, "brand"),
      model: requiredText(device, "model"),
      androidVersion: requiredText(device, "androidVersion", 40),
      sdkInt: positiveInteger(device, "sdkInt", 100),
      supportedAbis: supportedAbis(device),
      socManufacturer: optionalText(device, "socManufacturer"),
      socModel: optionalText(device, "socModel"),
      totalRamBytes,
      availableRamBytes,
      totalStorageBytes,
      availableStorageBytes,
    },
  };
}
