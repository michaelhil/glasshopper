#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { getBoolean, getNumber, getString, helpText, parseCli, parseRect, parseWindowMatch, requireString } from "./cli.ts";
import { toErrorMessage } from "./errors.ts";
import { formatDisplay, formatWindow } from "./format.ts";
import { describePanelWindows, formatPanelStatus, listPanelWindows } from "./panels.ts";
import { createPlatformAdapter } from "./platform/windows.ts";
import { getSimStateViaAgent, listMsfsProcessesViaAgent, setWindowTitleViaAgent } from "./platform/windows-agent.ts";
import {
  createPanelProfile,
  createPanelProfileFromWindow,
  findDisplay,
  findOneWindow,
  readProfile,
  resolveRect,
  writeProfile
} from "./profiles.ts";
import type { DisplayInfo, GlasshopperProfile, PanelProfile, PlatformAdapter, Rect, WindowInfo } from "./types.ts";

const findDisplayByArg = (displays: readonly DisplayInfo[], value: string): DisplayInfo => {
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
    throw new Error(`Display "${value}" was not found. Run "glasshopper discover" to list connected displays.`);
  }

  return display;
};

const promptLine = async (message: string): Promise<string> => {
  process.stdout.write(message);
  const line = await new Promise<string>((resolve): void => {
    process.stdin.resume();
    process.stdin.once("data", (data: Buffer): void => {
      resolve(data.toString("utf8"));
    });
  });
  return line.trim();
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
};

const glasshopperTitle = (profileName: string, panelName: string): string =>
  `Glasshopper:${profileName}:${panelName}`;

const findWindowByHandle = (windows: readonly WindowInfo[], handle: string): WindowInfo | undefined =>
  windows.find((candidate) => candidate.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());

const upsertPanel = (profile: GlasshopperProfile, panel: PanelProfile): GlasshopperProfile => ({
  version: 1,
  profiles: [...profile.profiles.filter((existing) => existing.name !== panel.name), panel]
});

const identifyPanelByHandle = async (input: {
  readonly platform: PlatformAdapter;
  readonly profileName: string;
  readonly handle: string;
  readonly name: string;
  readonly displayArg: string;
  readonly alwaysOnTop: boolean;
}): Promise<void> => {
  const title = glasshopperTitle(input.profileName, input.name);
  const [displays, windows, profile] = await Promise.all([
    input.platform.listDisplays(),
    input.platform.listWindows({ includeAll: true }),
    readProfile(input.profileName)
  ]);
  const window = findWindowByHandle(windows, input.handle);
  if (!window) {
    throw new Error(`Window "${input.handle}" was not found.`);
  }
  const display = findDisplayByArg(displays, input.displayArg);
  await setWindowTitleViaAgent(input.handle, title);
  const panel = createPanelProfileFromWindow({
    name: input.name,
    title,
    window: { ...window, title },
    display,
    alwaysOnTop: input.alwaysOnTop
  });
  await writeProfile(input.profileName, upsertPanel(profile, panel));
};

const updateLayoutFromCurrent = async (
  platform: PlatformAdapter,
  profileName: string,
  displayArg: string
): Promise<number> => {
  const [displays, windows, profile] = await Promise.all([
    platform.listDisplays(),
    platform.listWindows({ includeAll: true }),
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

const findProfileFailures = (
  displays: readonly DisplayInfo[],
  windows: readonly WindowInfo[],
  profile: GlasshopperProfile
): string[] => {
  const failures: string[] = [];
  if (profile.profiles.length === 0) {
    failures.push("Profile has no panels.");
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

const getStaleProfileEntries = (
  windows: readonly WindowInfo[],
  profile: GlasshopperProfile
): readonly PanelProfile[] =>
  profile.profiles.filter((panel) => {
    try {
      findOneWindow(windows, panel.window, panel.name);
      return false;
    } catch {
      return true;
    }
  });

const bringInOffscreenPanels = async (input: {
  readonly platform: PlatformAdapter;
  readonly displayArg: string;
  readonly dryRun: boolean;
}): Promise<number> => {
  const [displays, windows] = await Promise.all([
    input.platform.listDisplays(),
    input.platform.listWindows({ includeAll: true })
  ]);
  const display = findDisplayByArg(displays, input.displayArg);
  const panels = describePanelWindows(windows, displays).filter((panel) => !panel.onscreen);
  const margin = 16;
  const gap = 16;
  let cursorX = display.workingArea.x + margin;
  let cursorY = display.workingArea.y + margin;
  let rowHeight = 0;

  for (const panel of panels) {
    const width = Math.min(panel.window.rect.width || 800, display.workingArea.width - margin * 2);
    const height = Math.min(panel.window.rect.height || 700, display.workingArea.height - margin * 2);
    if (cursorX + width > display.workingArea.x + display.workingArea.width - margin) {
      cursorX = display.workingArea.x + margin;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    if (cursorY + height > display.workingArea.y + display.workingArea.height - margin) {
      cursorY = display.workingArea.y + margin;
    }

    const rect = { x: cursorX, y: cursorY, width, height };
    console.log(`${input.dryRun ? "Would move" : "Moved"} ${panel.window.handle} ${panel.window.title || "(untitled)"} -> ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
    if (!input.dryRun) {
      await input.platform.moveWindow({
        handle: panel.window.handle,
        rect,
        alwaysOnTop: true
      });
    }
    cursorX += width + gap;
    rowHeight = Math.max(rowHeight, height);
  }

  return panels.length;
};

const captureNextPanel = async (input: {
  readonly platform: PlatformAdapter;
  readonly profileName: string;
  readonly name: string;
  readonly displayArg: string;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly alwaysOnTop: boolean;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Promise<WindowInfo> => {
  const [displays, baselineWindows, profile] = await Promise.all([
    input.platform.listDisplays(),
    input.platform.listWindows({ includeAll: true }),
    readProfile(input.profileName)
  ]);
  const display = findDisplayByArg(displays, input.displayArg);
  const baselineHandles = new Set(
    listPanelWindows(baselineWindows).map((window) => window.handle.toLocaleLowerCase())
  );
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() <= deadline) {
    const windows = await input.platform.listWindows({ includeAll: true });
    const panel = listPanelWindows(windows).find(
      (window) => !baselineHandles.has(window.handle.toLocaleLowerCase())
    );

    if (!panel) {
      await sleep(input.intervalMs);
      continue;
    }

    const title = glasshopperTitle(input.profileName, input.name);
    const margin = 16;
    const defaultX = display.workingArea.x - display.bounds.x + margin;
    const defaultY = display.workingArea.y - display.bounds.y + margin;
    const defaultWidth = Math.min(panel.rect.width || 1024, display.workingArea.width - margin * 2);
    const defaultHeight = Math.min(panel.rect.height || 768, display.workingArea.height - margin * 2);
    const relativeRect: Rect = {
      x: getNumber(input.flags, "x", defaultX)!,
      y: getNumber(input.flags, "y", defaultY)!,
      width: getNumber(input.flags, "width", defaultWidth)!,
      height: getNumber(input.flags, "height", defaultHeight)!
    };

    await setWindowTitleViaAgent(panel.handle, title);
    await input.platform.moveWindow({
      handle: panel.handle,
      rect: {
        x: display.bounds.x + relativeRect.x,
        y: display.bounds.y + relativeRect.y,
        width: relativeRect.width,
        height: relativeRect.height
      },
      alwaysOnTop: input.alwaysOnTop
    });

    const savedPanel = createPanelProfile({
      name: input.name,
      window: {
        titleExact: title,
        processName: panel.processName,
        className: panel.className
      },
      display,
      rect: relativeRect,
      alwaysOnTop: input.alwaysOnTop
    });
    await writeProfile(input.profileName, upsertPanel(profile, savedPanel));

    return { ...panel, title };
  }

  throw new Error(`Timed out after ${Math.round(input.timeoutMs / 1000)}s waiting for a new MSFS pop-out panel.`);
};

const adoptUnprofiledPanels = async (input: {
  readonly platform: PlatformAdapter;
  readonly profileName: string;
  readonly displayArg: string;
  readonly alwaysOnTop: boolean;
}): Promise<number> => {
  let adopted = 0;
  while (true) {
    const [displays, windows, profile] = await Promise.all([
      input.platform.listDisplays(),
      input.platform.listWindows({ includeAll: true }),
      readProfile(input.profileName)
    ]);
    const statuses = describePanelWindows(windows, displays, profile);
    const unprofiled = statuses.filter((status) => !status.profiledAs);
    if (unprofiled.length === 0) {
      return adopted;
    }

    console.log(unprofiled.map(formatPanelStatus).join("\n\n"));
    const choice = await promptLine("Handle to adopt, or Enter to stop: ");
    if (!choice) {
      return adopted;
    }
    const selected = unprofiled.find(
      (status) =>
        status.window.handle.toLocaleLowerCase() === choice.toLocaleLowerCase() ||
        choice === String(unprofiled.indexOf(status))
    );
    if (!selected) {
      console.log(`No unprofiled panel matched "${choice}".`);
      continue;
    }

    const name = await promptLine(`Name for ${selected.window.handle} (${selected.window.title || "untitled"}): `);
    if (!name) {
      console.log("Skipped.");
      continue;
    }

    await identifyPanelByHandle({
      platform: input.platform,
      profileName: input.profileName,
      handle: selected.window.handle,
      name,
      displayArg: input.displayArg,
      alwaysOnTop: input.alwaysOnTop
    });
    console.log(`Adopted ${selected.window.handle} as ${glasshopperTitle(input.profileName, name)}.`);
    adopted++;
  }
};

const main = async (): Promise<void> => {
  const rawArgs = Bun.argv.slice(2);
  const { command, flags } = parseCli(rawArgs);
  const subcommand = rawArgs[1];
  const platform = createPlatformAdapter();

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(helpText);
    return;
  }

  if (command === "doctor") {
    const displays = await platform.listDisplays();
    const windows = await platform.listWindows({ includeAll: false });
    const msfsProcesses = process.platform === "win32" ? await listMsfsProcessesViaAgent() : [];
    const simState = process.platform === "win32" ? await getSimStateViaAgent() : undefined;
    console.log(`adapter: ${platform.name}`);
    console.log(`displays: ${displays.length}`);
    console.log(`likely MSFS windows: ${windows.length}`);
    console.log(`MSFS-like processes: ${msfsProcesses.length}`);
    if (simState) {
      console.log(`SimConnect: ${simState.connected ? "connected" : simState.available ? "available, not connected" : "unavailable"}`);
      if (simState.aircraftName) {
        console.log(`aircraft: ${simState.aircraftName}`);
      }
      if (simState.cameraState != null) {
        console.log(
          `camera: state=${simState.cameraState} view0=${simState.cameraViewTypeAndIndex0 ?? "?"} view1=${simState.cameraViewTypeAndIndex1 ?? "?"}`
        );
      }
      if (simState.error) {
        console.log(`SimConnect detail: ${simState.error}`);
      }
    }
    console.log(displays.map(formatDisplay).join("\n\n"));
    if (windows.length > 0) {
      console.log("\nWindows:\n");
      console.log(windows.map(formatWindow).join("\n\n"));
    }
    if (windows.length === 0 && msfsProcesses.length > 0) {
      console.log("\nMSFS-like processes without enumerable windows:\n");
      console.log(
        msfsProcesses
          .map(
            (item) =>
              `${item.processName}(${item.processId}) handle=${item.mainWindowHandle} responding=${item.responding}`
          )
          .join("\n")
      );
    }
    return;
  }

  if (command === "discover") {
    const includeAll = getBoolean(flags, "all");
    const [displays, windows] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll })
    ]);
    console.log("Displays:\n");
    console.log(displays.map(formatDisplay).join("\n\n") || "(none)");
    console.log("\nWindows:\n");
    console.log(windows.map(formatWindow).join("\n\n") || "(none)");
    return;
  }

  if (command === "sim-state") {
    const simState = await getSimStateViaAgent();
    console.log(`SimConnect: ${simState.connected ? "connected" : simState.available ? "available, not connected" : "unavailable"}`);
    if (simState.sdkPath) {
      console.log(`sdk: ${simState.sdkPath}`);
    }
    if (simState.aircraftName) {
      console.log(`aircraft: ${simState.aircraftName}`);
    }
    if (simState.aircraftPath) {
      console.log(`aircraftPath: ${simState.aircraftPath}`);
    }
    if (simState.cameraState != null) {
      console.log(`cameraState: ${simState.cameraState}`);
      console.log(`cameraViewTypeAndIndex0: ${simState.cameraViewTypeAndIndex0 ?? "?"}`);
      console.log(`cameraViewTypeAndIndex1: ${simState.cameraViewTypeAndIndex1 ?? "?"}`);
      console.log(`cameraViewTypeAndIndex1Max: ${simState.cameraViewTypeAndIndex1Max ?? "?"}`);
      console.log(`cameraViewTypeAndIndex2Max: ${simState.cameraViewTypeAndIndex2Max ?? "?"}`);
    }
    if (simState.error) {
      console.log(`detail: ${simState.error}`);
    }
    return;
  }

  if (command === "panels") {
    const profileName = getString(flags, "profile");
    const [displays, windows, profile] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll: true }),
      profileName ? readProfile(profileName) : Promise.resolve(undefined)
    ]);
    const panels = describePanelWindows(windows, displays, profile);
    console.log(panels.map(formatPanelStatus).join("\n\n") || "(no MSFS pop-out panels found)");
    return;
  }

  if (command === "bring-in") {
    const dryRun = getBoolean(flags, "dry-run");
    const moved = await bringInOffscreenPanels({
      platform,
      displayArg: getString(flags, "display", "0")!,
      dryRun
    });
    if (moved === 0) {
      console.log("No offscreen MSFS pop-out panels found.");
    }
    return;
  }

  if (command === "capture-next") {
    const profileName = getString(flags, "profile", "default")!;
    const name = requireString(flags, "name");
    console.log(`Waiting for next MSFS pop-out panel to save as "${name}".`);
    console.log("Return to MSFS fullscreen and pop out the panel now.");
    const window = await captureNextPanel({
      platform,
      profileName,
      name,
      displayArg: getString(flags, "display", "0")!,
      flags,
      alwaysOnTop: getBoolean(flags, "topmost"),
      timeoutMs: getNumber(flags, "timeout", 60)! * 1000,
      intervalMs: getNumber(flags, "interval", 500)!
    });
    console.log(`Captured ${window.handle} as ${glasshopperTitle(profileName, name)} in "${profileName}".`);
    return;
  }

  if (command === "move") {
    const displays = await platform.listDisplays();
    const display = findDisplayByArg(displays, requireString(flags, "display"));
    const rect = parseRect(flags, display);
    await platform.moveWindow({
      handle: requireString(flags, "handle"),
      rect: {
        x: display.bounds.x + rect.x,
        y: display.bounds.y + rect.y,
        width: rect.width,
        height: rect.height
      },
      alwaysOnTop: getBoolean(flags, "topmost")
    });
    console.log("Moved window.");
    return;
  }

  if (command === "rename") {
    const handle = requireString(flags, "handle");
    const title = requireString(flags, "title").trim();
    if (!title) {
      throw new Error("--title cannot be empty.");
    }
    await setWindowTitleViaAgent(handle, title);
    console.log(`Renamed ${handle} -> ${title}`);
    return;
  }

  if (command === "identify") {
    const profileName = getString(flags, "profile", "default")!;
    const handle = requireString(flags, "handle");
    const name = requireString(flags, "name");
    await identifyPanelByHandle({
      platform,
      profileName,
      handle,
      name,
      displayArg: getString(flags, "display", "0")!,
      alwaysOnTop: getBoolean(flags, "topmost")
    });
    console.log(`Identified ${handle} as ${glasshopperTitle(profileName, name)} and saved "${name}" to ${profileName}.`);
    return;
  }

  if (command === "adopt") {
    const profileName = getString(flags, "profile", "default")!;
    const adopted = await adoptUnprofiledPanels({
      platform,
      profileName,
      displayArg: getString(flags, "display", "0")!,
      alwaysOnTop: getBoolean(flags, "topmost")
    });
    console.log(`Adopted ${adopted} panel(s) into "${profileName}".`);
    return;
  }

  if (command === "save") {
    const profileName = getString(flags, "profile", "default")!;
    const displays = await platform.listDisplays();
    const display = findDisplayByArg(displays, requireString(flags, "display"));
    const profile = await readProfile(profileName);
    const panel = createPanelProfile({
      name: requireString(flags, "name"),
      window: parseWindowMatch(flags),
      display,
      rect: parseRect(flags, display),
      alwaysOnTop: getBoolean(flags, "topmost")
    });
    const profiles = profile.profiles.filter((existing) => existing.name !== panel.name);
    await writeProfile(profileName, { version: 1, profiles: [...profiles, panel] });
    console.log(`Saved "${panel.name}" to ${profileName}.`);
    return;
  }

  if (command === "layout") {
    if (!getBoolean(flags, "from-current")) {
      throw new Error("Only layout --from-current is supported for now.");
    }
    const profileName = getString(flags, "profile", "default")!;
    const count = await updateLayoutFromCurrent(platform, profileName, getString(flags, "display", "0")!);
    console.log(`Updated ${count} panel placement(s) in "${profileName}" from current windows.`);
    return;
  }

  if (command === "remove") {
    const profileName = getString(flags, "profile", "default")!;
    const name = requireString(flags, "name");
    const profile = await readProfile(profileName);
    const profiles = profile.profiles.filter((panel) => panel.name !== name);
    if (profiles.length === profile.profiles.length) {
      throw new Error(`Profile "${profileName}" has no panel named "${name}".`);
    }
    await writeProfile(profileName, { version: 1, profiles });
    console.log(`Removed "${name}" from ${profileName}.`);
    return;
  }

  if (command === "repair") {
    const profileName = getString(flags, "profile", "default")!;
    const prune = getBoolean(flags, "prune");
    const [windows, profile] = await Promise.all([
      platform.listWindows({ includeAll: true }),
      readProfile(profileName)
    ]);
    const stale = getStaleProfileEntries(windows, profile);
    if (stale.length === 0) {
      console.log(`Profile "${profileName}" has no stale entries.`);
      return;
    }
    console.log(`Stale entries in "${profileName}":`);
    console.log(stale.map((panel) => `- ${panel.name}`).join("\n"));
    if (prune) {
      if (listPanelWindows(windows).length === 0) {
        throw new Error("No live MSFS pop-out panels are visible. Refusing to prune because the simulator may be closed or inaccessible.");
      }
      await writeProfile(profileName, {
        version: 1,
        profiles: profile.profiles.filter((panel) => !stale.some((stalePanel) => stalePanel.name === panel.name))
      });
      console.log(`Removed ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"}.`);
      return;
    }
    console.log(`Run "bun run glasshopper repair --profile ${profileName} --prune" to remove them.`);
    return;
  }

  if (command === "profile") {
    if (subcommand === "list") {
      let names: string[] = [];
      try {
        const files = await readdir("profiles");
        names = files.filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, ""));
      } catch {
        names = [];
      }
      console.log(names.join("\n") || "(no profiles found)");
      return;
    }

    if (subcommand === "show") {
      const profileName = getString(flags, "profile", "default")!;
      const [displays, windows, profile, simState] = await Promise.all([
        platform.listDisplays(),
        platform.listWindows({ includeAll: true }),
        readProfile(profileName),
        process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined)
      ]);
      console.log(`Profile: ${profileName}`);
      console.log(`panels: ${profile.profiles.length}`);
      if (simState?.aircraftName) {
        console.log(`current aircraft: ${simState.aircraftName}`);
      }
      const failures = findProfileFailures(displays, windows, profile);
      console.log(`health: ${failures.length === 0 ? "ready" : "needs attention"}`);
      for (const panel of profile.profiles) {
        try {
          const window = findOneWindow(windows, panel.window, panel.name);
          const display = findDisplay(displays, panel.placement, panel.name);
          console.log(`- ${panel.name}: ready ${window.handle} -> ${display.identity.friendlyName ?? display.identity.deviceName}`);
        } catch (error) {
          console.log(`- ${panel.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        console.log("\nSuggestions:");
        console.log(`- bun run glasshopper panels --profile ${profileName}`);
        console.log(`- bun run glasshopper repair --profile ${profileName}`);
      }
      return;
    }

    throw new Error(`Unknown profile command "${subcommand ?? ""}". Use "profile list" or "profile show --profile <name>".`);
  }

  if (command === "setup") {
    const profileName = getString(flags, "profile", "default")!;
    const displayArg = getString(flags, "display", "0")!;
    const alwaysOnTop = getBoolean(flags, "topmost");
    const simState = process.platform === "win32" ? await getSimStateViaAgent() : undefined;
    console.log(`Profile: ${profileName}`);
    console.log(`SimConnect: ${simState?.connected ? "connected" : simState?.available ? "available, not connected" : "unavailable"}`);
    if (simState?.aircraftName) {
      console.log(`aircraft: ${simState.aircraftName}`);
    }

    const moved = await bringInOffscreenPanels({ platform, displayArg, dryRun: false });
    if (moved === 0) {
      console.log("No offscreen panels needed staging.");
    }

    const adopted = await adoptUnprofiledPanels({
      platform,
      profileName,
      displayArg,
      alwaysOnTop
    });
    console.log(`Adopted ${adopted} panel(s).`);

    await promptLine("Arrange panels now, then press Enter to save the layout...");
    const count = await updateLayoutFromCurrent(platform, profileName, displayArg);
    console.log(`Saved layout for ${count} panel(s).`);

    const [displays, windows, profile] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll: true }),
      readProfile(profileName)
    ]);
    const failures = findProfileFailures(displays, windows, profile);
    if (failures.length > 0) {
      console.log("Setup finished, but preflight needs attention:");
      console.log(failures.map((failure) => `- ${failure}`).join("\n"));
      process.exit(1);
    }
    console.log(`Setup complete. Preflight passed for "${profileName}".`);
    return;
  }

  if (command === "apply") {
    const profileName = getString(flags, "profile", "default")!;
    const dryRun = getBoolean(flags, "dry-run");
    const profile = await readProfile(profileName);
    const [displays, windows, simState] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll: true }),
      process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined)
    ]);

    if (dryRun) {
      console.log(`Profile: ${profileName}`);
      console.log(`panels: ${profile.profiles.length}`);
      console.log(`windows: ${windows.length}`);
      if (simState) {
        console.log(`SimConnect: ${simState.connected ? "connected" : simState.available ? "available, not connected" : "unavailable"}`);
        if (simState.error) {
          console.log(`SimConnect detail: ${simState.error}`);
        }
      }
    }

    for (const panel of profile.profiles) {
      const window = findOneWindow(windows, panel.window, panel.name);
      const display = findDisplay(displays, panel.placement, panel.name);
      if (dryRun) {
        console.log(`Ready ${panel.name} -> ${display.identity.friendlyName ?? display.identity.deviceName} using ${window.handle}`);
        continue;
      }
      await platform.moveWindow({
        handle: window.handle,
        rect: resolveRect(display, panel.placement),
        alwaysOnTop: panel.placement.alwaysOnTop ?? false
      });
      console.log(`Applied ${panel.name} -> ${display.identity.friendlyName ?? display.identity.deviceName}`);
    }
    return;
  }

  if (command === "preflight") {
    const profileName = getString(flags, "profile", "default")!;
    const profile = await readProfile(profileName);
    const [displays, windows, simState, msfsProcesses] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll: true }),
      process.platform === "win32" ? getSimStateViaAgent() : Promise.resolve(undefined),
      process.platform === "win32" ? listMsfsProcessesViaAgent() : Promise.resolve([])
    ]);

    const failures: string[] = [];
    if (profile.profiles.length === 0) {
      failures.push(`Profile "${profileName}" has no panels.`);
    }
    if (msfsProcesses.length === 0) {
      failures.push("No MSFS-like process is running.");
    }
    if (!windows.some((window) => window.kind?.startsWith("msfs-"))) {
      failures.push("No enumerable MSFS window or pop-out was found.");
    }
    if (simState && !simState.connected) {
      failures.push(`SimConnect is not connected${simState.error ? `: ${simState.error}` : "."}`);
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

    if (failures.length > 0) {
      console.log("Preflight failed:");
      console.log(failures.map((failure) => `- ${failure}`).join("\n"));
      process.exit(1);
    }

    console.log(`Preflight passed for "${profileName}".`);
    return;
  }

  throw new Error(`Unknown command "${command}".\n\n${helpText}`);
};

try {
  await main();
} catch (error) {
  console.error(toErrorMessage(error));
  process.exit(1);
}
