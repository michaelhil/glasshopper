import type { MoveWindowRequest, PlatformAdapter } from "../types.ts";

export const createMockAdapter = (): PlatformAdapter => ({
  name: "mock-macos-development",

  listDisplays: async () => [
    {
      index: 0,
      isPrimary: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workingArea: { x: 0, y: 25, width: 2560, height: 1415 },
      identity: {
        stableId: "mock-primary-2560x1440",
        deviceName: "DISPLAY1",
        friendlyName: "Mock Primary",
        fingerprint: "DISPLAY1|0,0|2560x1440|primary",
        confidence: "low"
      }
    }
  ],

  listWindows: async () => [
    {
      handle: "0x10001",
      title: "Microsoft Flight Simulator 2024 - Mock Popout",
      className: "AceApp",
      processId: 4242,
      processName: "FlightSimulator2024",
      rect: { x: 100, y: 100, width: 800, height: 600 },
      isVisible: true
    }
  ],

  moveWindow: async (request: MoveWindowRequest): Promise<void> => {
    console.log(
      `mock move ${request.handle} -> ${request.rect.x},${request.rect.y} ${request.rect.width}x${request.rect.height}`
    );
  }
});
