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
  readonly latestView?: ChasePlaneViewSummary;
  readonly views: readonly ChasePlaneViewSummary[];
}

interface ObservedChasePlaneView {
  readonly guid: string;
  readonly mode?: number;
  readonly seenAt: number;
}

const appData = (): string | undefined => process.env["APPDATA"];
const localAppData = (): string | undefined => process.env["LOCALAPPDATA"];
let observerSocket: WebSocket | undefined;
let observerReconnect: ReturnType<typeof setTimeout> | undefined;
let latestObservedView: ObservedChasePlaneView | undefined;

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

const chasePlaneLogPath = (): string | undefined => {
  const local = localAppData();
  if (!local) {
    return undefined;
  }
  return join(local, "Programs", "Parallel 42", "ChasePlane", "V2", "MSFS2024", "Logs", "cp_log.txt");
};

const parseBridgeViewMessage = (message: string): ObservedChasePlaneView | undefined => {
  const match = /^CAM_PRESET_LOAD::(\d+),([0-9a-f-]+),/i.exec(message);
  if (!match) {
    return undefined;
  }
  const mode = Number(match[1]);
  return {
    guid: match[2]!,
    ...(Number.isFinite(mode) ? { mode } : {}),
    seenAt: Date.now()
  };
};

export const startChasePlaneBridgeObserver = (): void => {
  if (observerSocket || observerReconnect) {
    return;
  }

  try {
    const socket = new WebSocket("ws://localhost:8652");
    observerSocket = socket;
    socket.addEventListener("message", (event) => {
      const observed = parseBridgeViewMessage(String(event.data));
      if (observed) {
        latestObservedView = observed;
      }
    });
    socket.addEventListener("close", () => {
      observerSocket = undefined;
      observerReconnect = setTimeout(() => {
        observerReconnect = undefined;
        startChasePlaneBridgeObserver();
      }, 3000);
    });
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });
  } catch {
    observerSocket = undefined;
  }
};

const resolveObservedView = async (
  observed: ObservedChasePlaneView,
  aircraftPath?: string
): Promise<ChasePlaneViewSummary> => {
  const views = await listChasePlaneViews(aircraftPath);
  const known = views.find((view) => view.guid.toLocaleLowerCase() === observed.guid.toLocaleLowerCase());
  return {
    guid: observed.guid,
    name: known?.name ?? `ChasePlane view ${observed.guid.slice(0, 8)}`,
    ...(observed.mode != null ? { mode: observed.mode } : known?.mode != null ? { mode: known.mode } : {}),
    ...(known?.index != null ? { index: known.index } : {}),
    ...(known?.profileTheme ? { profileTheme: known.profileTheme } : {}),
    ...(known?.aircraft ? { aircraft: known.aircraft } : {})
  };
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

const viewFilePath = async (
  guid: string,
  aircraftPath?: string
): Promise<string | undefined> => {
  const workPath = chasePlaneWorkPath();
  const aircraftSlug = aircraftSlugFromPath(aircraftPath) ?? (workPath ? await latestAircraftSlug(workPath) : undefined);
  if (!workPath || !aircraftSlug) {
    return undefined;
  }

  return join(workPath, "aircraft", aircraftSlug, "onboard", `${guid}.json`);
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
  startChasePlaneBridgeObserver();
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
    latestView?: ChasePlaneViewSummary;
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
  if (latestObservedView) {
    state.latestView = await resolveObservedView(latestObservedView, aircraftPath);
  }
  return state;
};

export const getLatestChasePlaneLoadedView = async (
  aircraftPath?: string
): Promise<ChasePlaneViewSummary | undefined> => {
  startChasePlaneBridgeObserver();
  if (latestObservedView) {
    return await resolveObservedView(latestObservedView, aircraftPath);
  }

  const logPath = chasePlaneLogPath();
  if (!logPath) {
    return undefined;
  }

  try {
    const [raw, views] = await Promise.all([
      readFile(logPath, "utf8"),
      listChasePlaneViews(aircraftPath)
    ]);
    const byGuid = new Map(views.map((view) => [view.guid.toLocaleLowerCase(), view]));
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
      const match = /load_preset source=.*?\bmode=(\d+)\s+guid=([0-9a-f-]+)/i.exec(lines[index] ?? "");
      if (!match) {
        continue;
      }
      const mode = Number(match[1]);
      const guid = match[2]!;
      const known = byGuid.get(guid.toLocaleLowerCase());
      return {
        guid,
        name: known?.name ?? `ChasePlane view ${guid.slice(0, 8)}`,
        ...(Number.isFinite(mode) ? { mode } : {}),
        ...(known?.index != null ? { index: known.index } : {}),
        ...(known?.profileTheme ? { profileTheme: known.profileTheme } : {}),
        ...(known?.aircraft ? { aircraft: known.aircraft } : {})
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

export const setChasePlaneView = async (input: {
  readonly guid: string;
  readonly aircraftPath?: string;
  readonly timeoutMs?: number;
}): Promise<ChasePlaneViewSummary> => {
  const path = await viewFilePath(input.guid, input.aircraftPath);
  if (!path) {
    throw new Error("Could not resolve ChasePlane view path.");
  }

  let viewPayload: Record<string, unknown>;
  try {
    viewPayload = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`ChasePlane view "${input.guid}" was not found for the current aircraft.`);
  }

  const name = typeof viewPayload["name"] === "string" ? viewPayload["name"] : `ChasePlane view ${input.guid.slice(0, 8)}`;
  const mode = typeof viewPayload["mode"] === "number" ? viewPayload["mode"] : undefined;
  const timeoutMs = input.timeoutMs ?? 5000;

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket("ws://localhost:8652");
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error(`Timed out waiting for ChasePlane to load "${name}".`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ message: "api_connect", payload: { client_name: "Glasshopper" } }));
      setTimeout(() => {
        socket.send(JSON.stringify({ message: "cam_set_position", payload: viewPayload }));
      }, 250);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          readonly message?: string;
          readonly status?: number;
          readonly payload?: {
            readonly preset_guid?: string;
          };
        };
        if (
          message.message === "cam_mode_set" &&
          message.status === 200 &&
          message.payload?.preset_guid?.toLocaleLowerCase() === input.guid.toLocaleLowerCase()
        ) {
          latestObservedView = {
            guid: input.guid,
            ...(mode != null ? { mode } : {}),
            seenAt: Date.now()
          };
          cleanup();
          resolve();
        }
      } catch {}
    });
    socket.addEventListener("error", () => {
      cleanup();
      reject(new Error("Could not connect to the ChasePlane API."));
    });
  });

  return {
    guid: input.guid,
    name,
    ...(mode != null ? { mode } : {})
  };
};
