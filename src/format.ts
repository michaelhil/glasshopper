import type { DisplayInfo, Rect, WindowInfo } from "./types.ts";

export const formatRect = (rect: Rect): string =>
  `${rect.x},${rect.y} ${rect.width}x${rect.height}`;

export const formatDisplay = (display: DisplayInfo): string => {
  const name = display.identity.friendlyName ?? display.identity.deviceName;
  const primary = display.isPrimary ? " primary" : "";
  return [
    `[${display.index}] ${name}${primary}`,
    `  stableId: ${display.identity.stableId}`,
    `  confidence: ${display.identity.confidence}`,
    `  bounds: ${formatRect(display.bounds)}`,
    `  fingerprint: ${display.identity.fingerprint}`
  ].join("\n");
};

export const formatWindow = (window: WindowInfo): string =>
  [
    `${window.handle} ${window.processName}(${window.processId})`,
    `  title: ${window.title || "(untitled)"}`,
    `  class: ${window.className}`,
    `  rect: ${formatRect(window.rect)}`
  ].join("\n");
