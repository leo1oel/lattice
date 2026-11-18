import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventCallback } from "@tauri-apps/api/event";
import { activateAppLocale } from "../i18n";
import { clearAppLogs, getAppLogEntry, getVisibleAppToastIds } from "./app-log-store";
import { DOWNLOAD_SAVED_EVENT, installSavedDownloadNotice } from "./saved-downloads";

const host = vi.hoisted(() => ({ handlers: new Map<string, EventCallback<unknown>>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: EventCallback<unknown>) => {
    host.handlers.set(event, handler);
    return () => host.handlers.delete(event);
  }),
}));

async function saved(path: string) {
  await vi.waitFor(() => expect(host.handlers.has(DOWNLOAD_SAVED_EVENT)).toBe(true));
  host.handlers.get(DOWNLOAD_SAVED_EVENT)!({ event: DOWNLOAD_SAVED_EVENT, id: 1, payload: path });
}

const toastTitles = () => getVisibleAppToastIds().map((id) => getAppLogEntry(id)!.title);

describe("installSavedDownloadNotice", () => {
  afterEach(async () => {
    clearAppLogs();
    await activateAppLocale("en");
  });

  it("says where an exported board image was saved, in the interface language", async () => {
    const stop = installSavedDownloadNotice();
    await saved("/Users/writer/Downloads/board.png");
    expect(toastTitles()).toEqual(["Saved to /Users/writer/Downloads/board.png"]);

    clearAppLogs();
    await activateAppLocale("zh-CN");
    await saved("/Users/writer/Downloads/board (1).png");
    expect(toastTitles()).toEqual(["已保存到 /Users/writer/Downloads/board (1).png"]);
    stop();
    await vi.waitFor(() => expect(host.handlers.has(DOWNLOAD_SAVED_EVENT)).toBe(false));
  });
});
