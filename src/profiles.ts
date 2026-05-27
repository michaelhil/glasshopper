import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DisplayInfo, GlasshopperProfile, PanelProfile, Placement, Rect, WindowInfo, WindowMatch } from "./types.ts";
import { fail } from "./errors.ts";

const profileDir = "profiles";

export const profilePath = (name: string): string => join(profileDir, `${name}.json`);

export const emptyProfile = (): GlasshopperProfile => ({
  version: 1,
  profiles: []
});

export const readProfile = async (name: string): Promise<GlasshopperProfile> => {
  const file = Bun.file(profilePath(name));
  if (!(await file.exists())) {
    return emptyProfile();
  }

  return (await file.json()) as GlasshopperProfile;
};

export const writeProfile = async (name: string, profile: GlasshopperProfile): Promise<void> => {
  const path = profilePath(name);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(profile, null, 2)}\n`);
};

export const matchWindow = (window: WindowInfo, match: WindowMatch): boolean => {
  const titleOk =
    !match.titleContains ||
    window.title.toLocaleLowerCase().includes(match.titleContains.toLocaleLowerCase());
  const processOk =
    !match.processName ||
    window.processName.toLocaleLowerCase() === match.processName.toLocaleLowerCase();
  const classOk =
    !match.className ||
    window.className.toLocaleLowerCase() === match.className.toLocaleLowerCase();

  return titleOk && processOk && classOk;
};

export const findOneWindow = (
  windows: readonly WindowInfo[],
  match: WindowMatch,
  profileName: string
): WindowInfo => {
  const matches = windows.filter((window) => matchWindow(window, match));
  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length === 0) {
    return fail(`Profile "${profileName}" did not match any visible window.`);
  }

  return fail(
    `Profile "${profileName}" matched ${matches.length} windows. Add a more specific title/process/class match.`
  );
};

export const findDisplay = (
  displays: readonly DisplayInfo[],
  placement: Placement,
  profileName: string
): DisplayInfo => {
  const stable = displays.find((display) => display.identity.stableId === placement.displayStableId);
  if (stable) {
    return stable;
  }

  const fallback = displays.find(
    (display) => display.identity.fingerprint === placement.displayFallbackFingerprint
  );
  if (fallback) {
    return fallback;
  }

  return fail(`Profile "${profileName}" target display is not connected.`);
};

export const resolveRect = (display: DisplayInfo, placement: Placement): Rect => ({
  x: display.bounds.x + placement.x,
  y: display.bounds.y + placement.y,
  width: placement.width,
  height: placement.height
});

export const createPanelProfile = (input: {
  readonly name: string;
  readonly window: WindowMatch;
  readonly display: DisplayInfo;
  readonly rect: Rect;
  readonly alwaysOnTop: boolean;
}): PanelProfile => ({
  name: input.name,
  window: input.window,
  placement: {
    displayStableId: input.display.identity.stableId,
    displayFallbackFingerprint: input.display.identity.fingerprint,
    x: input.rect.x,
    y: input.rect.y,
    width: input.rect.width,
    height: input.rect.height,
    alwaysOnTop: input.alwaysOnTop
  }
});
