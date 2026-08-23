import { describe, expect, it } from "vitest";
import { decodeBridgeValue, encodeBridgeValue } from "./browser-runtime";

describe("browser bridge serialization", () => {
  it("round-trips binary command bodies across more than one base64 chunk", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);

    const decoded = decodeBridgeValue(encodeBridgeValue(bytes)) as ArrayBuffer;

    expect(new Uint8Array(decoded)).toEqual(bytes);
  });

  it("preserves binary values nested in ordinary invoke arguments", () => {
    const value = {
      path: "figures/result.png",
      payload: new Uint8Array([0, 1, 2, 253, 254, 255]).buffer,
    };

    const decoded = decodeBridgeValue(encodeBridgeValue(value)) as {
      path: string;
      payload: ArrayBuffer;
    };

    expect(decoded.path).toBe(value.path);
    expect([...new Uint8Array(decoded.payload)]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("uses Tauri's custom IPC serializer when a value supplies one", () => {
    const value = {
      __TAURI_TO_IPC_KEY__: () => ({ Logical: { width: 1200, height: 680 } }),
    };

    expect(decodeBridgeValue(encodeBridgeValue(value))).toEqual({
      Logical: { width: 1200, height: 680 },
    });
  });
});
