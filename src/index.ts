#!/usr/bin/env bun
import { getBoolean, getString, helpText, parseCli, parseRect, parseWindowMatch, requireString } from "./cli.ts";
import { toErrorMessage } from "./errors.ts";
import { formatDisplay, formatWindow } from "./format.ts";
import { createPlatformAdapter } from "./platform/windows.ts";
import {
  createPanelProfile,
  findDisplay,
  findOneWindow,
  readProfile,
  resolveRect,
  writeProfile
} from "./profiles.ts";
import type { DisplayInfo } from "./types.ts";

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

const main = async (): Promise<void> => {
  const { command, flags } = parseCli(Bun.argv.slice(2));
  const platform = createPlatformAdapter();

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(helpText);
    return;
  }

  if (command === "doctor") {
    const displays = await platform.listDisplays();
    const windows = await platform.listWindows({ includeAll: false });
    console.log(`adapter: ${platform.name}`);
    console.log(`displays: ${displays.length}`);
    console.log(`likely MSFS windows: ${windows.length}`);
    console.log(displays.map(formatDisplay).join("\n\n"));
    if (windows.length > 0) {
      console.log("\nWindows:\n");
      console.log(windows.map(formatWindow).join("\n\n"));
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

  if (command === "apply") {
    const profileName = getString(flags, "profile", "default")!;
    const profile = await readProfile(profileName);
    const [displays, windows] = await Promise.all([
      platform.listDisplays(),
      platform.listWindows({ includeAll: true })
    ]);

    for (const panel of profile.profiles) {
      const window = findOneWindow(windows, panel.window, panel.name);
      const display = findDisplay(displays, panel.placement, panel.name);
      await platform.moveWindow({
        handle: window.handle,
        rect: resolveRect(display, panel.placement),
        alwaysOnTop: panel.placement.alwaysOnTop ?? false
      });
      console.log(`Applied ${panel.name} -> ${display.identity.friendlyName ?? display.identity.deviceName}`);
    }
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
