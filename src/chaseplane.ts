import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listMsfsProcessesViaAgent } from "./platform/windows-agent.ts";

export interface ChasePlaneViewSummary {
  readonly guid: string;
  readonly name: string;
  readonly index?: number;
  readonly mode?: number;
  readonly profileTheme?: string;
  readonly aircraft?: string;
}

export interface ChasePlaneState {
  readonly detected: boolean;
  readonly bridgeProcess?: string;
  readonly bridgeProcessId?: number;
  readonly bridgeConnected: boolean;
  readonly workPath?: string;
  readonly aircraftSlug?: string;
  readonly views: readonly ChasePlaneViewSummary[];
}

const appData = (): string | undefined => process.env["APPDATA"];

const aircraftSlugFromPath = (aircraftPath?: string): string | undefined => {
  if (!aircraftPath) {
    return undefined;
  }
  const normalized = aircraftPath.replaceAll("\\", "/");
  const configIndex = normalized.toLowerCase().lastIndexOf("/config/");
  const beforeConfig = configIndex >= 0 ? normalized.slice(0, configIndex) : normalized;
  return beforeConfig.split("/").filter(Boolean).at(-1)?.toLowerCase();
};

const chasePlaneWorkPath = (): string | undefined => {
  const roaming = appData();
  if (!roaming) {
    return undefined;
  }
  return join(roaming, "Microsoft Flight Simulator 2024", "WASM", "MSFS2024", "p42-util-chaseplane", "work");
};

const latestAircraftSlug = async (workPath: string): Promise<string | undefined> => {
  try {
    const aircraftDir = join(workPath, "aircraft");
    const entries = await readdir(aircraftDir, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<{ readonly slug: string; readonly mtimeMs: number }> => {
          try {
            const onboard = await stat(join(aircraftDir, entry.name, "onboard"));
            return { slug: entry.name, mtimeMs: onboard.mtimeMs };
          } catch {
            return { slug: entry.name, mtimeMs: 0 };
          }
        })
    );
    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.slug;
  } catch {
    return undefined;
  }
};

export const canReachChasePlaneBridge = async (): Promise<boolean> => {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out connecting to ChasePlane bridge."));
      }, 1200);
      const socket = new WebSocket("ws://localhost:8652");
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ChasePlane bridge websocket error."));
      });
    });
    return true;
  } catch {
    return false;
  }
};

export const listChasePlaneViews = async (
  aircraftPath?: string
): Promise<readonly ChasePlaneViewSummary[]> => {
  const workPath = chasePlaneWorkPath();
  const aircraftSlug = aircraftSlugFromPath(aircraftPath) ?? (workPath ? await latestAircraftSlug(workPath) : undefined);
  if (!workPath || !aircraftSlug) {
    return [];
  }

  const onboardDir = join(workPath, "aircraft", aircraftSlug, "onboard");
  try {
    const files = (await readdir(onboardDir)).filter((file) => file.endsWith(".json"));
    const views = await Promise.all(
      files.map(async (file): Promise<ChasePlaneViewSummary | undefined> => {
        try {
          const raw = await readFile(join(onboardDir, file), "utf8");
          const parsed = JSON.parse(raw) as {
            readonly guid?: string;
            readonly name?: string;
            readonly index?: number;
            readonly mode?: number;
            readonly profile_theme?: string;
            readonly aircraft?: string;
          };
          if (!parsed.guid || !parsed.name) {
            return undefined;
          }
          const view: {
            guid: string;
            name: string;
            index?: number;
            mode?: number;
            profileTheme?: string;
            aircraft?: string;
          } = {
            guid: parsed.guid,
            name: parsed.name
          };
          if (parsed.index != null) {
            view.index = parsed.index;
          }
          if (parsed.mode != null) {
            view.mode = parsed.mode;
          }
          if (parsed.profile_theme) {
            view.profileTheme = parsed.profile_theme;
          }
          if (parsed.aircraft) {
            view.aircraft = parsed.aircraft;
          }
          return view;
        } catch {
          return undefined;
        }
      })
    );
    return views
      .filter((view): view is ChasePlaneViewSummary => Boolean(view))
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0) || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
};

export const getChasePlaneState = async (
  aircraftPath?: string
): Promise<ChasePlaneState> => {
  const [processes, bridgeConnected, views] = await Promise.all([
    process.platform === "win32" ? listMsfsProcessesViaAgent() : Promise.resolve([]),
    canReachChasePlaneBridge(),
    listChasePlaneViews(aircraftPath)
  ]);
  const bridge = processes.find((process) => process.processName.toLowerCase() === "cp msfs bridge");
  const workPath = chasePlaneWorkPath();
  const state: {
    detected: boolean;
    bridgeProcess?: string;
    bridgeProcessId?: number;
    bridgeConnected: boolean;
    workPath?: string;
    aircraftSlug?: string;
    views: readonly ChasePlaneViewSummary[];
  } = {
    detected: Boolean(bridge) || bridgeConnected || views.length > 0,
    bridgeConnected,
    views
  };
  if (bridge?.processName) {
    state.bridgeProcess = bridge.processName;
  }
  if (bridge?.processId != null) {
    state.bridgeProcessId = bridge.processId;
  }
  if (workPath) {
    state.workPath = workPath;
  }
  const aircraftSlug = aircraftSlugFromPath(aircraftPath) ?? (workPath ? await latestAircraftSlug(workPath) : undefined);
  if (aircraftSlug) {
    state.aircraftSlug = aircraftSlug;
  }
  return state;
};
