import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DisplayInfo, GlasshopperProfile, PanelProfile, Placement, Rect, WindowInfo, WindowMatch } from "./types.ts";
import { fail } from "./errors.ts";

const legacyProfileDir = "profiles";

export const legacyProfileDirectory = (): string => legacyProfileDir;

export const profileDirectory = (): string => {
  const override = process.env["GLASSHOPPER_PROFILE_DIR"];
  if (override) {
    return override;
  }

  const appData = process.env["APPDATA"];
  if (appData) {
    return join(appData, "Glasshopper", "profiles");
  }

  return legacyProfileDir;
};

export const profilePath = (name: string): string => join(profileDirectory(), `${name}.json`);

export const legacyProfilePath = (name: string): string => join(legacyProfileDir, `${name}.json`);

export const emptyProfile = (): GlasshopperProfile => ({
  version: 1,
  profiles: []
});

export const readProfile = async (name: string): Promise<GlasshopperProfile> => {
  const file = Bun.file(profilePath(name));
  if (await file.exists()) {
    return (await file.json()) as GlasshopperProfile;
  }

  const legacyFile = Bun.file(legacyProfilePath(name));
  if (await legacyFile.exists()) {
    return (await legacyFile.json()) as GlasshopperProfile;
  }

  return emptyProfile();
};

export const writeProfile = async (name: string, profile: GlasshopperProfile): Promise<void> => {
  const path = profilePath(name);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(profile, null, 2)}\n`);
};

export const matchWindow = (window: WindowInfo, match: WindowMatch): boolean => {
  const exactTitleOk =
    !match.titleExact ||
    window.title.toLocaleLowerCase() === match.titleExact.toLocaleLowerCase();
  const titleOk =
    !match.titleContains ||
    window.title.toLocaleLowerCase().includes(match.titleContains.toLocaleLowerCase());
  const processOk =
    !match.processName ||
    window.processName.toLocaleLowerCase() === match.processName.toLocaleLowerCase();
  const classOk =
    !match.className ||
    window.className.toLocaleLowerCase() === match.className.toLocaleLowerCase();

  return exactTitleOk && titleOk && processOk && classOk;
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

  if (matches.length > 1 && match.titleExact) {
    return fail(`Profile "${profileName}" matched ${matches.length} windows with exact title "${match.titleExact}". Rename or close duplicate pop-outs.`);
  }

  if (matches.length > 1 && match.titleContains) {
    const exactTitleMatches = matches.filter(
      (window) => window.title.toLocaleLowerCase() === match.titleContains?.toLocaleLowerCase()
    );
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0]!;
    }
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

export const createPanelProfileFromWindow = (input: {
  readonly name: string;
  readonly title: string;
  readonly window: WindowInfo;
  readonly display: DisplayInfo;
  readonly alwaysOnTop: boolean;
}): PanelProfile => ({
  name: input.name,
  window: {
    titleExact: input.title,
    processName: input.window.processName,
    className: input.window.className
  },
  placement: {
    displayStableId: input.display.identity.stableId,
    displayFallbackFingerprint: input.display.identity.fingerprint,
    x: input.window.rect.x - input.display.bounds.x,
    y: input.window.rect.y - input.display.bounds.y,
    width: input.window.rect.width,
    height: input.window.rect.height,
    alwaysOnTop: input.alwaysOnTop
  }
});
