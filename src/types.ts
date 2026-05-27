export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayIdentity {
  readonly stableId: string;
  readonly deviceName: string;
  readonly friendlyName?: string;
  readonly manufacturer?: string;
  readonly productCode?: string;
  readonly serialNumber?: string;
  readonly instanceName?: string;
  readonly fingerprint: string;
  readonly confidence: "high" | "medium" | "low";
}

export interface DisplayInfo {
  readonly index: number;
  readonly isPrimary: boolean;
  readonly bounds: Rect;
  readonly workingArea: Rect;
  readonly identity: DisplayIdentity;
}

export interface WindowInfo {
  readonly handle: string;
  readonly title: string;
  readonly className: string;
  readonly processId: number;
  readonly processName: string;
  readonly rect: Rect;
  readonly isVisible: boolean;
  readonly kind?: string;
}

export interface ProcessInfo {
  readonly processId: number;
  readonly processName: string;
  readonly mainWindowHandle: string;
  readonly mainWindowTitle: string;
  readonly responding: boolean;
}

export interface SimState {
  readonly available: boolean;
  readonly connected: boolean;
  readonly sdkPath?: string;
  readonly aircraftPath?: string;
  readonly aircraftName?: string;
  readonly cameraState?: number;
  readonly cameraViewTypeAndIndex0?: number;
  readonly cameraViewTypeAndIndex1?: number;
  readonly cameraViewTypeAndIndex1Max?: number;
  readonly cameraViewTypeAndIndex2Max?: number;
  readonly error?: string;
}

export interface WindowMatch {
  readonly titleExact?: string;
  readonly titleContains?: string;
  readonly processName?: string;
  readonly className?: string;
}

export interface Placement {
  readonly displayStableId: string;
  readonly displayFallbackFingerprint?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly alwaysOnTop?: boolean;
}

export interface PanelProfile {
  readonly name: string;
  readonly window: WindowMatch;
  readonly placement: Placement;
}

export interface GlasshopperProfile {
  readonly version: 1;
  readonly profiles: readonly PanelProfile[];
}

export interface MoveWindowRequest {
  readonly handle: string;
  readonly rect: Rect;
  readonly alwaysOnTop: boolean;
}

export interface PlatformAdapter {
  readonly name: string;
  listDisplays: () => Promise<readonly DisplayInfo[]>;
  listWindows: (options: { readonly includeAll: boolean }) => Promise<readonly WindowInfo[]>;
  moveWindow: (request: MoveWindowRequest) => Promise<void>;
}
