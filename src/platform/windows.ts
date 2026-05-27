import type { DisplayInfo, MoveWindowRequest, PlatformAdapter, WindowInfo } from "../types.ts";
import { createMockAdapter } from "./mock.ts";
import { parsePowerShellJson, runPowerShell } from "./powershell.ts";

const ensureWindows = (): void => {
  if (process.platform !== "win32") {
    throw new Error("Windows adapter requires Windows. Use GLASSHOPPER_MOCK=1 for local development checks.");
  }
};

const displayScript = String.raw`
Add-Type -AssemblyName System.Windows.Forms

function Convert-ArrayString($value) {
  if ($null -eq $value) { return $null }
  $chars = @()
  foreach ($item in $value) {
    if ($item -ne 0) { $chars += [char]$item }
  }
  -join $chars
}

$monitorIds = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    instanceName = $_.InstanceName
    friendlyName = Convert-ArrayString $_.UserFriendlyName
    manufacturer = Convert-ArrayString $_.ManufacturerName
    productCode = Convert-ArrayString $_.ProductCodeID
    serialNumber = Convert-ArrayString $_.SerialNumberID
  }
})

$screens = @([System.Windows.Forms.Screen]::AllScreens)
$result = for ($i = 0; $i -lt $screens.Count; $i++) {
  $screen = $screens[$i]
  $monitor = if ($i -lt $monitorIds.Count) { $monitorIds[$i] } else { $null }
  $bounds = $screen.Bounds
  $working = $screen.WorkingArea
  $serial = if ($monitor -and $monitor.serialNumber) { $monitor.serialNumber.Trim() } else { $null }
  $friendly = if ($monitor -and $monitor.friendlyName) { $monitor.friendlyName.Trim() } else { $screen.DeviceName }
  $fingerprint = "$($screen.DeviceName)|$($bounds.X),$($bounds.Y)|$($bounds.Width)x$($bounds.Height)|primary=$($screen.Primary)"
  $stableId = if ($serial) {
    "monitor:$serial"
  } elseif ($monitor -and $monitor.instanceName) {
    "monitor:$($monitor.instanceName)"
  } else {
    "screen:$fingerprint"
  }
  $confidence = if ($serial) { "high" } elseif ($monitor -and $monitor.instanceName) { "medium" } else { "low" }

  [pscustomobject]@{
    index = $i
    isPrimary = $screen.Primary
    bounds = [pscustomobject]@{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
    workingArea = [pscustomobject]@{ x = $working.X; y = $working.Y; width = $working.Width; height = $working.Height }
    identity = [pscustomobject]@{
      stableId = $stableId
      deviceName = $screen.DeviceName
      friendlyName = $friendly
      manufacturer = if ($monitor) { $monitor.manufacturer } else { $null }
      productCode = if ($monitor) { $monitor.productCode } else { $null }
      serialNumber = $serial
      instanceName = if ($monitor) { $monitor.instanceName } else { $null }
      fingerprint = $fingerprint
      confidence = $confidence
    }
  }
}

$result | ConvertTo-Json -Depth 8 -Compress
`;

const windowScript = (includeAll: boolean): string => String.raw`
$source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class NativeWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue

$includeAll = ${includeAll ? "$true" : "$false"}
$windows = New-Object System.Collections.Generic.List[object]

[NativeWindows]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [NativeWindows]::IsWindowVisible($hWnd)) { return $true }

  $titleBuilder = New-Object System.Text.StringBuilder 512
  $classBuilder = New-Object System.Text.StringBuilder 256
  [void][NativeWindows]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
  [void][NativeWindows]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)

  $title = $titleBuilder.ToString()
  $className = $classBuilder.ToString()
  if ([string]::IsNullOrWhiteSpace($title) -and -not $includeAll) { return $true }

  [uint32]$pid = 0
  [void][NativeWindows]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  $processName = "unknown"
  try {
    $processName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName
  } catch {}

  $isLikelyMsfs = $processName -match "FlightSimulator|Limitless|MSFS" -or $title -match "Flight Simulator|MSFS|Microsoft Flight"
  if (-not $includeAll -and -not $isLikelyMsfs) { return $true }

  $rect = New-Object NativeWindows+Rect
  [void][NativeWindows]::GetWindowRect($hWnd, [ref]$rect)
  $windows.Add([pscustomobject]@{
    handle = ("0x{0:X}" -f $hWnd.ToInt64())
    title = $title
    className = $className
    processId = [int]$pid
    processName = $processName
    rect = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    }
    isVisible = $true
  })
  return $true
}, [IntPtr]::Zero) | Out-Null

$windows | ConvertTo-Json -Depth 6 -Compress
`;

const moveScript = (request: MoveWindowRequest): string => {
  const handle = request.handle.startsWith("0x")
    ? request.handle
    : `0x${request.handle}`;
  const topMost = request.alwaysOnTop ? "-1" : "-2";

  return String.raw`
$source = @"
using System;
using System.Runtime.InteropServices;

public static class NativeMove {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue

$handle = [IntPtr]::new([Convert]::ToInt64("${handle}", 16))
[void][NativeMove]::ShowWindow($handle, 9)
$ok = [NativeMove]::SetWindowPos($handle, [IntPtr]::new(${topMost}), ${request.rect.x}, ${request.rect.y}, ${request.rect.width}, ${request.rect.height}, 0x0040)
if (-not $ok) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "SetWindowPos failed with Win32 error $code"
}
@{ ok = $true } | ConvertTo-Json -Compress
`;
};

export const createWindowsAdapter = (): PlatformAdapter => ({
  name: "windows",

  listDisplays: async (): Promise<readonly DisplayInfo[]> => {
    ensureWindows();
    const result = await runPowerShell(displayScript);
    const displays = parsePowerShellJson<DisplayInfo[] | DisplayInfo>(result.stdout);
    return Array.isArray(displays) ? displays : [displays];
  },

  listWindows: async (options: { readonly includeAll: boolean }): Promise<readonly WindowInfo[]> => {
    ensureWindows();
    const result = await runPowerShell(windowScript(options.includeAll));
    if (!result.stdout || result.stdout === "null") {
      return [];
    }
    const windows = parsePowerShellJson<WindowInfo[] | WindowInfo>(result.stdout);
    return Array.isArray(windows) ? windows : [windows];
  },

  moveWindow: async (request: MoveWindowRequest): Promise<void> => {
    ensureWindows();
    await runPowerShell(moveScript(request));
  }
});

export const createPlatformAdapter = (): PlatformAdapter => {
  if (process.env["GLASSHOPPER_MOCK"] === "1") {
    return createMockAdapter();
  }

  return createWindowsAdapter();
};
