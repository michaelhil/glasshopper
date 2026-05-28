import { createPanelProfile, readProfile, writeProfile } from "./profiles.ts";
import { listPanelWindows } from "./panels.ts";
import { getChasePlaneState, getLatestChasePlaneLoadedView, setChasePlaneView } from "./chaseplane.ts";
import { createPlatformAdapter } from "./platform/windows.ts";
import {
  captureClickViaAgent,
  getCursorPositionViaAgent,
  getSimStateViaAgent,
  popOutClickViaAgent,
  restoreCameraViaAgent,
  setWindowTitleViaAgent
} from "./platform/windows-agent.ts";
import {
  findDisplayByArg,
  glasshopperTitle,
  relativeRectForDisplay,
  upsertPanel
} from "./app-core.ts";
import type { PanelSourceBinding, PlatformAdapter, WindowInfo } from "./types.ts";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export interface CaptureOptions {
  readonly profileName: string;
  readonly displayArg: string;
  readonly alwaysOnTop: boolean;
  readonly name?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly source?: PanelSourceBinding;
}

export interface CaptureResult {
  readonly name: string;
  readonly title: string;
  readonly handle: string;
}

export const capturePanelWindow = async (
  platform: PlatformAdapter,
  panel: WindowInfo,
  options: CaptureOptions
): Promise<CaptureResult> => {
  const [displays, profile] = await Promise.all([
    platform.listDisplays(),
    readProfile(options.profileName)
  ]);
  const name = options.name || `panel-${profile.profiles.length + 1}`;
  const title = glasshopperTitle(options.profileName, name);
  const display = findDisplayByArg(displays, options.displayArg);
  const relativeRect = relativeRectForDisplay(display, panel, options);

  await setWindowTitleViaAgent(panel.handle, title);
  await platform.moveWindow({
    handle: panel.handle,
    rect: {
      x: display.bounds.x + relativeRect.x,
      y: display.bounds.y + relativeRect.y,
      width: relativeRect.width,
      height: relativeRect.height
    },
    alwaysOnTop: options.alwaysOnTop
  });

  const savedPanel = createPanelProfile({
    name,
    window: {
      titleExact: title,
      processName: panel.processName,
      className: panel.className
    },
    display,
    rect: relativeRect,
    alwaysOnTop: options.alwaysOnTop
  });
  const previous = profile.profiles.find((candidate) => candidate.name === name);
  const source = options.source ?? previous?.source;
  await writeProfile(
    options.profileName,
    upsertPanel(profile, source ? { ...savedPanel, source } : savedPanel)
  );

  return { name, title, handle: panel.handle };
};

export const captureNextPanel = async (
  options: CaptureOptions & {
    readonly timeoutMs: number;
    readonly intervalMs: number;
  }
): Promise<CaptureResult> => {
  const platform = createPlatformAdapter();
  const baselineWindows = await platform.listWindows({ includeAll: false });
  const baselineHandles = new Set(
    listPanelWindows(baselineWindows).map((window) => window.handle.toLocaleLowerCase())
  );
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() <= deadline) {
    const windows = await platform.listWindows({ includeAll: false });
    const panel = listPanelWindows(windows).find(
      (window) => !baselineHandles.has(window.handle.toLocaleLowerCase())
    );
    if (panel) {
      return await capturePanelWindow(platform, panel, options);
    }
    await sleep(options.intervalMs);
  }

  throw new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for a new MSFS pop-out panel.`);
};

export interface CaptureListenerSnapshot {
  readonly active: boolean;
  readonly busy: boolean;
  readonly profileName: string;
  readonly displayArg: string;
  readonly alwaysOnTop: boolean;
  readonly captured: readonly CaptureResult[];
  readonly pendingSource?: PanelSourceBinding;
  readonly lastError?: string;
}

export class CaptureListener {
  private active = false;
  private busy = false;
  private clickBusy = false;
  private sessionId = 0;
  private baselineHandles = new Set<string>();
  private captured: CaptureResult[] = [];
  private pendingSource:
    | {
        readonly source: PanelSourceBinding;
        readonly expiresAt: number;
      }
    | undefined;
  private pendingPanel:
    | {
        readonly panel: WindowInfo;
        readonly capturedAt: number;
      }
    | undefined;
  private lastError: string | undefined;
  private options: CaptureOptions = {
    profileName: "a320",
    displayArg: "0",
    alwaysOnTop: true
  };

  async start(options: CaptureOptions): Promise<void> {
    const sessionId = this.sessionId + 1;
    this.sessionId = sessionId;
    this.options = options;
    this.captured = [];
    this.pendingSource = undefined;
    this.pendingPanel = undefined;
    this.lastError = undefined;
    const platform = createPlatformAdapter();
    const windows = await platform.listWindows({ includeAll: false });
    this.baselineHandles = new Set(
      listPanelWindows(windows).map((window) => window.handle.toLocaleLowerCase())
    );
    this.active = true;
    void this.loop(sessionId);
    void this.clickLoop(sessionId);
  }

  stop(): void {
    this.active = false;
    this.sessionId++;
  }

  snapshot(): CaptureListenerSnapshot {
    const snapshot: {
      active: boolean;
      busy: boolean;
      profileName: string;
      displayArg: string;
      alwaysOnTop: boolean;
      captured: readonly CaptureResult[];
      pendingSource?: PanelSourceBinding;
      lastError?: string;
    } = {
      active: this.active,
      busy: this.busy,
      profileName: this.options.profileName,
      displayArg: this.options.displayArg,
      alwaysOnTop: this.options.alwaysOnTop,
      captured: this.captured
    };
    if (this.pendingSource && this.pendingSource.expiresAt > Date.now()) {
      snapshot.pendingSource = this.pendingSource.source;
    }
    if (this.lastError) {
      snapshot.lastError = this.lastError;
    }
    return snapshot;
  }

  private takePendingSource(): PanelSourceBinding | undefined {
    const source = this.pendingSource && this.pendingSource.expiresAt > Date.now()
      ? this.pendingSource.source
      : undefined;
    this.pendingSource = undefined;
    return source;
  }

  private async createSourceFromPoint(point: { readonly x: number; readonly y: number }): Promise<PanelSourceBinding> {
    const simState = process.platform === "win32" ? await getSimStateViaAgent() : undefined;
    const chasePlaneState = process.platform === "win32"
      ? await getChasePlaneState(simState?.aircraftPath)
      : undefined;
    const bindingInput: {
      x: number;
      y: number;
      clickMethod: "altGrClick" | "ctrlClick";
      cameraProvider?: "msfs" | "chaseplane" | "manual";
      chasePlaneBridgeConnected?: boolean;
      chasePlaneViewGuid?: string;
      chasePlaneViewName?: string;
      chasePlaneViewMode?: number;
      simState?: {
        readonly aircraftName?: string;
        readonly aircraftPath?: string;
        readonly cameraState?: number;
        readonly cameraViewTypeAndIndex0?: number;
        readonly cameraViewTypeAndIndex1?: number;
      };
    } = {
      x: point.x,
      y: point.y,
      clickMethod: "altGrClick",
      cameraProvider: chasePlaneState?.detected ? "chaseplane" : "msfs"
    };
    if (chasePlaneState?.bridgeConnected != null) {
      bindingInput.chasePlaneBridgeConnected = chasePlaneState.bridgeConnected;
    }
    if (chasePlaneState?.detected) {
      const chasePlaneView = await getLatestChasePlaneLoadedView(simState?.aircraftPath);
      if (chasePlaneView) {
        bindingInput.chasePlaneViewGuid = chasePlaneView.guid;
        bindingInput.chasePlaneViewName = chasePlaneView.name;
        if (chasePlaneView.mode != null) {
          bindingInput.chasePlaneViewMode = chasePlaneView.mode;
        }
      }
    }
    if (simState) {
      bindingInput.simState = simState;
    }
    return createSourceBinding(bindingInput);
  }

  private isCurrentSession(sessionId: number): boolean {
    return this.active && this.sessionId === sessionId;
  }

  private async loop(sessionId: number): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    const platform = createPlatformAdapter();
    try {
      while (this.active) {
        const windows = await platform.listWindows({ includeAll: false });
        const panel = listPanelWindows(windows).find(
          (window) => !this.baselineHandles.has(window.handle.toLocaleLowerCase())
        );
        if (!panel) {
          await sleep(500);
          continue;
        }

        this.baselineHandles.add(panel.handle.toLocaleLowerCase());
        const cursorSource = process.platform === "win32"
          ? await this.createSourceFromPoint(await getCursorPositionViaAgent())
          : undefined;
        const pendingSource = this.takePendingSource() ?? cursorSource;
        if (!pendingSource) {
          this.pendingPanel = {
            panel,
            capturedAt: Date.now()
          };
          await sleep(1500);
          const lateSource = this.takePendingSource();
          this.pendingPanel = undefined;
          const result = await capturePanelWindow(platform, panel, {
            ...this.options,
            ...(lateSource ? { source: lateSource } : {})
          });
          this.captured = [...this.captured, result];
          continue;
        }
        const result = await capturePanelWindow(platform, panel, {
          ...this.options,
          ...(pendingSource ? { source: pendingSource } : {})
        });
        this.captured = [...this.captured, result];
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.active = false;
    } finally {
      this.busy = false;
    }
  }

  private async clickLoop(sessionId: number): Promise<void> {
    if (this.clickBusy && this.sessionId === sessionId) {
      return;
    }
    this.clickBusy = true;
    try {
      while (this.isCurrentSession(sessionId)) {
        const click = await captureClickViaAgent(10000);
        if (!this.isCurrentSession(sessionId)) {
          break;
        }
        this.pendingSource = {
          source: await this.createSourceFromPoint(click),
          expiresAt: Date.now() + 12000
        };
        if (this.pendingPanel && Date.now() - this.pendingPanel.capturedAt < 5000) {
          this.pendingPanel = undefined;
        }
      }
    } catch (error) {
      if (this.isCurrentSession(sessionId)) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.sessionId === sessionId) {
        this.clickBusy = false;
      }
    }
  }
}

export const createSourceBinding = (input: {
  readonly x: number;
  readonly y: number;
  readonly clickMethod: "altGrClick" | "ctrlClick";
  readonly cameraProvider?: "msfs" | "chaseplane" | "manual";
  readonly chasePlaneBridgeConnected?: boolean;
  readonly chasePlaneViewGuid?: string;
  readonly chasePlaneViewName?: string;
  readonly chasePlaneViewMode?: number;
  readonly simState?: {
    readonly aircraftName?: string;
    readonly aircraftPath?: string;
    readonly cameraState?: number;
    readonly cameraViewTypeAndIndex0?: number;
    readonly cameraViewTypeAndIndex1?: number;
  };
}): PanelSourceBinding => {
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
    chasePlaneViewGuid?: string;
    chasePlaneViewName?: string;
    chasePlaneViewMode?: number;
    clickMethod: "altGrClick" | "ctrlClick";
    capturedAt: string;
  } = {
    x: input.x,
    y: input.y,
    cameraProvider: input.cameraProvider ?? "msfs",
    clickMethod: input.clickMethod,
    capturedAt: new Date().toISOString()
  };
  if (input.chasePlaneBridgeConnected != null) {
    source.chasePlaneBridgeConnected = input.chasePlaneBridgeConnected;
  }
  if (input.chasePlaneViewGuid) {
    source.chasePlaneViewGuid = input.chasePlaneViewGuid;
  }
  if (input.chasePlaneViewName) {
    source.chasePlaneViewName = input.chasePlaneViewName;
  }
  if (input.chasePlaneViewMode != null) {
    source.chasePlaneViewMode = input.chasePlaneViewMode;
  }
  if (input.simState?.aircraftName) {
    source.aircraftName = input.simState.aircraftName;
  }
  if (input.simState?.aircraftPath) {
    source.aircraftPath = input.simState.aircraftPath;
  }
  if (input.simState?.cameraState != null) {
    source.cameraState = input.simState.cameraState;
  }
  if (input.simState?.cameraViewTypeAndIndex0 != null) {
    source.cameraViewTypeAndIndex0 = input.simState.cameraViewTypeAndIndex0;
  }
  if (input.simState?.cameraViewTypeAndIndex1 != null) {
    source.cameraViewTypeAndIndex1 = input.simState.cameraViewTypeAndIndex1;
  }
  return source;
};

export const autoReopenPanel = async (input: {
  readonly profileName: string;
  readonly panelName: string;
  readonly displayArg?: string;
  readonly alwaysOnTop?: boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<CaptureResult> => {
  const profile = await readProfile(input.profileName);
  const saved = profile.profiles.find((panel) => panel.name === input.panelName);
  if (!saved) {
    throw new Error(`Profile "${input.profileName}" has no panel named "${input.panelName}".`);
  }
  if (!saved.source) {
    throw new Error(`Panel "${input.panelName}" has no bound source.`);
  }

  const platform = createPlatformAdapter();
  const baselineWindows = await platform.listWindows({ includeAll: false });
  const baselineHandles = new Set(
    listPanelWindows(baselineWindows).map((window) => window.handle.toLocaleLowerCase())
  );

  const methods: Array<"altGrClick" | "ctrlClick"> = saved.source.clickMethod === "altGrClick"
    ? ["altGrClick", "ctrlClick"]
    : ["ctrlClick", "altGrClick"];

  const cameraRequest: {
    cameraState?: number;
    cameraViewTypeAndIndex0?: number;
    cameraViewTypeAndIndex1?: number;
  } = {};
  if (saved.source.cameraState != null) {
    cameraRequest.cameraState = saved.source.cameraState;
  }
  if (saved.source.cameraViewTypeAndIndex0 != null) {
    cameraRequest.cameraViewTypeAndIndex0 = saved.source.cameraViewTypeAndIndex0;
  }
  if (saved.source.cameraViewTypeAndIndex1 != null) {
    cameraRequest.cameraViewTypeAndIndex1 = saved.source.cameraViewTypeAndIndex1;
  }
  const chasePlaneState = process.platform === "win32"
    ? await getChasePlaneState(saved.source.aircraftPath)
    : undefined;
  const hasStockCameraSource = Object.keys(cameraRequest).length > 0;
  const useChasePlaneSource = saved.source.cameraProvider === "chaseplane" ||
    Boolean(chasePlaneState?.detected && !hasStockCameraSource);
  const preservedSource: PanelSourceBinding = useChasePlaneSource && saved.source.cameraProvider !== "chaseplane"
    ? {
        ...saved.source,
        cameraProvider: "chaseplane",
        ...(chasePlaneState?.bridgeConnected != null
          ? { chasePlaneBridgeConnected: chasePlaneState.bridgeConnected }
          : {})
      }
    : saved.source;

  if (!useChasePlaneSource) {
    await restoreCameraViaAgent(cameraRequest);
    await sleep(750);
  } else if (saved.source.chasePlaneViewGuid) {
    const chasePlaneViewRequest: {
      guid: string;
      aircraftPath?: string;
    } = {
      guid: saved.source.chasePlaneViewGuid
    };
    if (saved.source.aircraftPath) {
      chasePlaneViewRequest.aircraftPath = saved.source.aircraftPath;
    }
    await setChasePlaneView(chasePlaneViewRequest);
    await sleep(750);
  }

  for (const method of methods) {
    await popOutClickViaAgent({
      x: saved.source.x,
      y: saved.source.y,
      clickMethod: method
    });

    const deadline = Date.now() + (input.timeoutMs ?? 5000);
    while (Date.now() <= deadline) {
      const windows = await platform.listWindows({ includeAll: false });
      const panel = listPanelWindows(windows).find(
        (window) => !baselineHandles.has(window.handle.toLocaleLowerCase())
      );
      if (panel) {
        return await capturePanelWindow(platform, panel, {
          profileName: input.profileName,
          name: input.panelName,
          displayArg: input.displayArg ?? saved.placement.displayStableId,
          alwaysOnTop: input.alwaysOnTop ?? saved.placement.alwaysOnTop ?? false,
          source: preservedSource
        });
      }
      await sleep(input.intervalMs ?? 500);
    }
  }

  throw new Error(`No new pop-out appeared after trying AltGr-click and Ctrl-click for "${input.panelName}".`);
};
