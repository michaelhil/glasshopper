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
}

export interface WindowMatch {
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
