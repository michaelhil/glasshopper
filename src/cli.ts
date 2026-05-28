import type { DisplayInfo, Rect, WindowMatch } from "./types.ts";
import { fail } from "./errors.ts";

export interface CliOptions {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

export const parseCli = (args: readonly string[]): CliOptions => {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, string | true>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return { command, flags };
};

export const getString = (
  flags: ReadonlyMap<string, string | true>,
  key: string,
  fallback?: string
): string | undefined => {
  const value = flags.get(key);
  if (value === true) {
    return fail(`--${key} requires a value.`);
  }

  return value ?? fallback;
};

export const getNumber = (
  flags: ReadonlyMap<string, string | true>,
  key: string,
  fallback?: number
): number | undefined => {
  const value = getString(flags, key);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fail(`--${key} must be a number.`);
  }

  return parsed;
};

export const getBoolean = (flags: ReadonlyMap<string, string | true>, key: string): boolean =>
  flags.get(key) === true || flags.get(key) === "true";

export const requireString = (flags: ReadonlyMap<string, string | true>, key: string): string =>
  getString(flags, key) ?? fail(`Missing required --${key}.`);

export const parseWindowMatch = (flags: ReadonlyMap<string, string | true>): WindowMatch => {
  const titleContains = getString(flags, "title");
  const processName = getString(flags, "process");
  const className = getString(flags, "class");
  const match: {
    titleContains?: string;
    processName?: string;
    className?: string;
  } = {};

  if (titleContains) {
    match.titleContains = titleContains;
  }

  if (processName) {
    match.processName = processName;
  }

  if (className) {
    match.className = className;
  }

  if (!match.titleContains && !match.processName && !match.className) {
    return fail("Provide at least one of --title, --process, or --class.");
  }

  return match;
};

export const parseRect = (flags: ReadonlyMap<string, string | true>, display: DisplayInfo): Rect => ({
  x: getNumber(flags, "x", 0)!,
  y: getNumber(flags, "y", 0)!,
  width: getNumber(flags, "width", display.bounds.width)!,
  height: getNumber(flags, "height", display.bounds.height)!
});

export const helpText = `glasshopper v0.1

Commands:
  doctor
    Check platform access, displays, and likely MSFS windows.

  discover [--all]
    List displays and likely MSFS windows. Use --all to include all visible windows.

  panels [--profile default]
    List MSFS pop-out panels with onscreen, duplicate-title, and profile status.

  bring-in [--display 0] [--dry-run]
    Move offscreen MSFS pop-out panels into a temporary visible staging layout.

  capture-next --profile default --name pfd [--display 0] [--topmost]
    Wait for the next new MSFS pop-out, rename it, stage it on a display, and save it.

  rename --handle 0x123 --title "Glasshopper:profile:panel"
    Rename a specific pop-out window so profiles can match duplicate panel titles.

  identify --profile default --handle 0x123 --name pfd [--display 0] [--topmost]
    Rename a panel as Glasshopper:<profile>:<name> and save its current layout.

  layout --profile default --from-current [--display 0]
    Update an existing profile's panel placements from their current window positions.

  remove --profile default --name panel-name
    Remove a stale panel entry from a profile.

  adopt --profile default [--display 0] [--topmost]
    Interactively name unprofiled MSFS pop-outs and save them to a profile.

  setup --profile default [--display 0] [--topmost]
    Guided flow: diagnose, bring in panels, adopt unprofiled panels, save layout, and preflight.

  repair --profile default [--prune]
    Report stale profile entries and optionally remove them.

  profile list
    List saved profiles.

  profile show --profile default
    Show profile entries and live matching health.

  sim-state
    Probe SimConnect availability and current aircraft/camera state.

  save --profile default --name pfd --display <stableId|index>
       --title <text> [--process FlightSimulator2024] [--class <class>]
       [--x 0 --y 0 --width 1024 --height 768] [--topmost]
    Save one conservative panel placement.

  apply --profile default [--dry-run]
    Validate or apply all placements in a profile. Fails if a panel matches zero or multiple windows.

  preflight --profile default
    Check whether a profile can safely run before sending any input or moving windows.

  move --handle 0x123 --display <stableId|index>
       [--x 0 --y 0 --width 1024 --height 768] [--topmost]
    Move a discovered window once without saving a profile.

Environment:
  GLASSHOPPER_MOCK=1 enables a fake adapter for non-Windows development checks.
`;
