import { findOneWindow } from "./profiles.ts";
import type { DisplayInfo, GlasshopperProfile, Rect, WindowInfo } from "./types.ts";

export interface PanelWindowStatus {
  readonly window: WindowInfo;
  readonly onscreen: boolean;
  readonly duplicateTitle: boolean;
  readonly profiledAs?: string;
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

export const isMsfsPanelWindow = (window: WindowInfo): boolean =>
  window.processName.toLocaleLowerCase() === "flightsimulator2024" &&
  window.className === "AceApp" &&
  window.kind !== "msfs-main" &&
  window.kind !== "msfs-multimonitor";

export const listPanelWindows = (windows: readonly WindowInfo[]): readonly WindowInfo[] =>
  windows.filter(isMsfsPanelWindow);

export const isOnscreen = (window: WindowInfo, displays: readonly DisplayInfo[]): boolean =>
  displays.some((display) => intersects(window.rect, display.bounds));

export const describePanelWindows = (
  windows: readonly WindowInfo[],
  displays: readonly DisplayInfo[],
  profile?: GlasshopperProfile
): readonly PanelWindowStatus[] => {
  const panels = listPanelWindows(windows);
  const titleCounts = new Map<string, number>();
  for (const panel of panels) {
    titleCounts.set(panel.title, (titleCounts.get(panel.title) ?? 0) + 1);
  }

  return panels.map((window) => {
    const profiled = profile?.profiles.find((panel) => {
      try {
        return findOneWindow(panels, panel.window, panel.name).handle === window.handle;
      } catch {
        return false;
      }
    });
    const status: {
      window: WindowInfo;
      onscreen: boolean;
      duplicateTitle: boolean;
      profiledAs?: string;
    } = {
      window,
      onscreen: isOnscreen(window, displays),
      duplicateTitle: (titleCounts.get(window.title) ?? 0) > 1
    };
    if (profiled) {
      status.profiledAs = profiled.name;
    }
    return status;
  });
};

export const formatPanelStatus = (status: PanelWindowStatus, index: number): string => {
  const flags = [
    status.onscreen ? "onscreen" : "offscreen",
    status.duplicateTitle ? "duplicate-title" : undefined,
    status.profiledAs ? `profiled:${status.profiledAs}` : "unprofiled"
  ].filter(Boolean);

  return [
    `[${index}] ${status.window.handle} ${status.window.title || "(untitled)"}`,
    `  ${flags.join(" ")}`,
    `  ${status.window.processName}(${status.window.processId}) ${status.window.className}`,
    `  rect: ${status.window.rect.x},${status.window.rect.y} ${status.window.rect.width}x${status.window.rect.height}`
  ].join("\n");
};
