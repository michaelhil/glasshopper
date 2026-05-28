import { readdir } from "node:fs/promises";
import { describePanelWindows, listPanelWindows } from "./panels.ts";
import { getChasePlaneState } from "./chaseplane.ts";
import { createPlatformAdapter } from "./platform/windows.ts";
import { captureClickViaAgent, getSimStateViaAgent, listMsfsProcessesViaAgent, setWindowTitleViaAgent } from "./platform/windows-agent.ts";
import {
  findDisplay,
  findOneWindow,
  legacyProfileDirectory,
  profileDirectory,
  readProfile,
  resolveRect,
  writeProfile
} from "./profiles.ts";
import type { DisplayInfo, GlasshopperProfile, PanelProfile, PlatformAdapter, Rect, WindowInfo } from "./types.ts";

export const glasshopperTitle = (profileName: string, panelName: string): string =>
  `Glasshopper:${profileName}:${panelName}`;

export const findDisplayByArg = (displays: readonly DisplayInfo[], value: string): DisplayInfo => {
  const index = Number(value);
  if (Number.isInteger(index)) {
    const display = displays.find((candidate) => candidate.index === index);
    if (display) {
      return display;
    }
  }

  const display = displays.find(
    (candidate) =>
      candidate.identity.stableId === value ||
      candidate.identity.deviceName === value ||
      candidate.identity.fingerprint === value
  );

  if (!display) {
    throw new Error(`Display "${value}" was not found.`);
  }

  return display;
};

export const findWindowByHandle = (windows: readonly WindowInfo[], handle: string): WindowInfo | undefined =>
  windows.find((candidate) => candidate.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());

export const upsertPanel = (profile: GlasshopperProfile, panel: PanelProfile): GlasshopperProfile => ({
  version: 1,
  profiles: [...profile.profiles.filter((existing) => existing.name !== panel.name), panel]
});

export const listProfiles = async (): Promise<readonly string[]> => {
  const names = new Set<string>();
  try {
    const files = await readdir(profileDirectory());
    for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
      names.add(file.replace(/\.json$/, ""));
    }
  } catch {}

  try {
    const files = await readdir(legacyProfileDirectory());
    for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
      names.add(file.replace(/\.json$/, ""));
    }
  } catch {}

  return [...names].sort();
};

export const updateLayoutFromCurrent = async (
  platform: PlatformAdapter,
  profileName: string,
  displayArg: string
): Promise<number> => {
  const [displays, windows, profile] = await Promise.all([
    platform.listDisplays(),
    platform.listWindows({ includeAll: false }),
    readProfile(profileName)
  ]);
  const display = findDisplayByArg(displays, displayArg);
  const updated = profile.profiles.map((panel) => {
    const window = findOneWindow(windows, panel.window, panel.name);
    return {
      ...panel,
      placement: {
        ...panel.placement,
        displayStableId: display.identity.stableId,
        displayFallbackFingerprint: display.identity.fingerprint,
        x: window.rect.x - display.bounds.x,
        y: window.rect.y - display.bounds.y,
        width: window.rect.width,
        height: window.rect.height
      }
    };
  });
  await writeProfile(profileName, { version: 1, profiles: updated });
  return updated.length;
};

export const findProfileFailures = (
  displays: readonly DisplayInfo[],
  windows: readonly WindowInfo[],
  profile: GlasshopperProfile,
  profileName: string
): string[] => {
  const failures: string[] = [];
  if (profile.profiles.length === 0) {
    failures.push(`Profile "${profileName}" has no panels.`);
  }

  for (const panel of profile.profiles) {
    try {
      findOneWindow(windows, panel.window, panel.name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      findDisplay(displays, panel.placement, panel.name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return failures;
};

export const preflightProfile = async (profileName: string): Promise<{
  readonly ok: boolean;
  readonly failures: readonly string[];
}> => {
  const platform = createPlatformAdapter();
  const profile = await readProfile(profileName);
  const [displays, windows, simState, msfsProcesses] = await Promise.all([
    platform.listDisplays(),
    platform.listWindows({ includeAll: false }),
    process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined),
    process.platform === "win32" ? listMsfsProcessesViaAgent() : Promise.resolve([])
  ]);

  const failures = findProfileFailures(displays, windows, profile, profileName);
  if (msfsProcesses.length === 0) {
    failures.push("No MSFS-like process is running.");
  }
  if (!windows.some((window) => window.kind?.startsWith("msfs-"))) {
    failures.push("No enumerable MSFS window or pop-out was found.");
  }
  if (simState && !simState.connected) {
    failures.push(`SimConnect is not connected${simState.error ? `: ${simState.error}` : "."}`);
  }

  return { ok: failures.length === 0, failures };
};

export const applyProfile = async (
  profileName: string,
  dryRun: boolean
): Promise<readonly string[]> => {
  const platform = createPlatformAdapter();
  const profile = await readProfile(profileName);
  const [displays, windows] = await Promise.all([
    platform.listDisplays(),
    platform.listWindows({ includeAll: false })
  ]);
  const messages: string[] = [];

  for (const panel of profile.profiles) {
    const window = findOneWindow(windows, panel.window, panel.name);
    const display = findDisplay(displays, panel.placement, panel.name);
    if (dryRun) {
      messages.push(`Ready ${panel.name} -> ${display.identity.friendlyName ?? display.identity.deviceName} using ${window.handle}`);
      continue;
    }
    await platform.moveWindow({
      handle: window.handle,
      rect: resolveRect(display, panel.placement),
      alwaysOnTop: panel.placement.alwaysOnTop ?? false
    });
    messages.push(`Applied ${panel.name} -> ${display.identity.friendlyName ?? display.identity.deviceName}`);
  }

  return messages;
};

export const removePanel = async (profileName: string, panelName: string): Promise<void> => {
  const profile = await readProfile(profileName);
  const profiles = profile.profiles.filter((panel) => panel.name !== panelName);
  if (profiles.length === profile.profiles.length) {
    throw new Error(`Profile "${profileName}" has no panel named "${panelName}".`);
  }
  await writeProfile(profileName, { version: 1, profiles });
};

export const renamePanel = async (
  profileName: string,
  panelName: string,
  nextName: string
): Promise<void> => {
  const trimmed = nextName.trim();
  if (!trimmed) {
    throw new Error("Panel name cannot be empty.");
  }

  const platform = createPlatformAdapter();
  const [windows, profile] = await Promise.all([
    platform.listWindows({ includeAll: false }),
    readProfile(profileName)
  ]);
  const existing = profile.profiles.find((panel) => panel.name === panelName);
  if (!existing) {
    throw new Error(`Profile "${profileName}" has no panel named "${panelName}".`);
  }

  const title = glasshopperTitle(profileName, trimmed);
  const matched = findOneWindow(windows, existing.window, panelName);
  await setWindowTitleViaAgent(matched.handle, title);

  const updated = profile.profiles.map((panel) => {
    if (panel.name !== panelName) {
      return panel;
    }
    return {
      ...panel,
      name: trimmed,
      window: {
        ...panel.window,
        titleExact: title
      }
    };
  });
  await writeProfile(profileName, { version: 1, profiles: updated });
};

export const bindPanelSource = async (
  profileName: string,
  panelName: string,
  timeoutMs: number,
  clickMethod: "altGrClick" | "ctrlClick"
): Promise<PanelProfile> => {
  const profile = await readProfile(profileName);
  const existing = profile.profiles.find((panel) => panel.name === panelName);
  if (!existing) {
    throw new Error(`Profile "${profileName}" has no panel named "${panelName}".`);
  }

  const [click, simState] = await Promise.all([
    captureClickViaAgent(timeoutMs),
    process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined)
  ]);
  const chasePlaneState = process.platform === "win32"
    ? await getChasePlaneState(simState?.aircraftPath)
    : undefined;
  const source: {
    x: number;
    y: number;
    cameraProvider?: "msfs" | "chaseplane" | "manual";
    aircraftName?: string;
    aircraftPath?: string;
    cameraState?: number;
    cameraViewTypeAndIndex0?: number;
    cameraViewTypeAndIndex1?: number;
    chasePlaneBridgeConnected?: boolean;
    clickMethod: "altGrClick" | "ctrlClick";
    capturedAt: string;
  } = {
    x: click.x,
    y: click.y,
    cameraProvider: chasePlaneState?.detected ? "chaseplane" : "msfs",
    clickMethod,
    capturedAt: new Date().toISOString()
  };
  if (chasePlaneState?.bridgeConnected != null) {
    source.chasePlaneBridgeConnected = chasePlaneState.bridgeConnected;
  }
  if (simState?.aircraftName) {
    source.aircraftName = simState.aircraftName;
  }
  if (simState?.aircraftPath) {
    source.aircraftPath = simState.aircraftPath;
  }
  if (simState?.cameraState != null) {
    source.cameraState = simState.cameraState;
  }
  if (simState?.cameraViewTypeAndIndex0 != null) {
    source.cameraViewTypeAndIndex0 = simState.cameraViewTypeAndIndex0;
  }
  if (simState?.cameraViewTypeAndIndex1 != null) {
    source.cameraViewTypeAndIndex1 = simState.cameraViewTypeAndIndex1;
  }

  const updatedPanel: PanelProfile = {
    ...existing,
    source
  };
  const profiles = profile.profiles.map((panel) => panel.name === panelName ? updatedPanel : panel);
  await writeProfile(profileName, { version: 1, profiles });
  return updatedPanel;
};

export const getAppState = async (profileName: string): Promise<Record<string, unknown>> => {
  const platform = createPlatformAdapter();
  const [profiles, displays, windows, profile, simState] = await Promise.all([
    listProfiles(),
    platform.listDisplays(),
    platform.listWindows({ includeAll: false }),
    readProfile(profileName),
    process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined)
  ]);
  const chasePlane = process.platform === "win32"
    ? await getChasePlaneState(simState?.aircraftPath)
    : undefined;
  const panels = describePanelWindows(windows, displays, profile);
  const profilePanels = profile.profiles.map((panel) => {
    try {
      const window = findOneWindow(windows, panel.window, panel.name);
      const display = findDisplay(displays, panel.placement, panel.name);
      return {
        ...panel,
        status: "ready",
        liveHandle: window.handle,
        liveRect: window.rect,
        displayName: display.identity.friendlyName ?? display.identity.deviceName
      };
    } catch (error) {
      return {
        ...panel,
        status: "missing",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  return {
    profileName,
    profiles,
    displays,
    simState,
    chasePlane,
    windows: windows.filter((window) => window.kind?.startsWith("msfs-")),
    panels,
    profilePanels,
    unprofiledCount: panels.filter((panel) => !panel.profiledAs).length,
    livePanelCount: listPanelWindows(windows).length
  };
};

export const relativeRectForDisplay = (
  display: DisplayInfo,
  window: WindowInfo,
  flags: { readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number }
): Rect => {
  const margin = 16;
  return {
    x: flags.x ?? display.workingArea.x - display.bounds.x + margin,
    y: flags.y ?? display.workingArea.y - display.bounds.y + margin,
    width: flags.width ?? Math.min(window.rect.width || 1024, display.workingArea.width - margin * 2),
    height: flags.height ?? Math.min(window.rect.height || 768, display.workingArea.height - margin * 2)
  };
};
