import type { PlatformAdapter } from "../types.ts";
import { createMockAdapter } from "./mock.ts";
import { listDisplaysViaAgent, listWindowsViaAgent, moveWindowViaAgent } from "./windows-agent.ts";

const ensureWindows = (): void => {
  if (process.platform !== "win32") {
    throw new Error("Windows adapter requires Windows. Use GLASSHOPPER_MOCK=1 for local development checks.");
  }
};

export const createWindowsAdapter = (): PlatformAdapter => ({
  name: "windows",

  listDisplays: async () => {
    ensureWindows();
    return await listDisplaysViaAgent();
  },

  listWindows: async (options) => {
    ensureWindows();
    return await listWindowsViaAgent(options.includeAll);
  },

  moveWindow: async (request) => {
    ensureWindows();
    await moveWindowViaAgent(request);
  }
});

export const createPlatformAdapter = (): PlatformAdapter => {
  if (process.env["GLASSHOPPER_MOCK"] === "1") {
    return createMockAdapter();
  }

  return createWindowsAdapter();
};
