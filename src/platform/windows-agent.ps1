param(
  [Parameter(Mandatory = $true)]
  [string]$GlasshopperCommand,

  [Parameter(Mandatory = $false)]
  [string]$PayloadJson = "{}"
)

$ErrorActionPreference = "Stop"

function Convert-ArrayString($value) {
  if ($null -eq $value) { return $null }
  $chars = @()
  foreach ($item in $value) {
    if ($item -ne 0) { $chars += [char]$item }
  }
  -join $chars
}

function Write-AgentResult($value) {
  [pscustomobject]@{ ok = $true; value = $value } | ConvertTo-Json -Depth 12 -Compress
}

function Write-AgentError($message) {
  [pscustomobject]@{ ok = $false; error = $message } | ConvertTo-Json -Depth 8 -Compress
}

function Add-NativeWindowsType {
  $source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class GlasshopperNativeWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetWindowText(IntPtr hWnd, string lpString);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll", PreserveSig = true)] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out Rect pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll", PreserveSig = true)] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  [StructLayout(LayoutKind.Sequential)] public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

  Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue
  [void][GlasshopperNativeWindows]::SetProcessDPIAware()
}

function Convert-Rect($rect) {
  [pscustomobject]@{
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
}

function Get-Displays {
  Add-NativeWindowsType
  Add-Type -AssemblyName System.Windows.Forms

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
  for ($i = 0; $i -lt $screens.Count; $i++) {
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
}

function Get-WindowKind($className, $title, $processName) {
  if ($processName -match "FlightSimulator2024|FlightSimulator|Limitless|MSFS") {
    if ($className -eq "AceApp") {
      if ($title -match "Microsoft Flight Simulator") { return "msfs-main" }
      if ([string]::IsNullOrWhiteSpace($title) -or $title -match "\(Custom\)") { return "msfs-custom-popout" }
      if ($title -match "WINDOW") { return "msfs-multimonitor" }
      return "msfs-built-in-popout"
    }
    return "msfs-process-window"
  }

  if ($className -eq "AceApp") {
    return "aceapp-window"
  }

  return "unknown"
}

function Get-Windows($includeAll) {
  Add-NativeWindowsType

  $windows = New-Object System.Collections.Generic.List[object]

  [GlasshopperNativeWindows]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [GlasshopperNativeWindows]::IsWindowVisible($hWnd)) { return $true }

    [int]$cloaked = 0
    [void][GlasshopperNativeWindows]::DwmGetWindowAttribute($hWnd, 14, [ref]$cloaked, 4)
    if ($cloaked -ne 0) { return $true }

    $titleBuilder = New-Object System.Text.StringBuilder 512
    $classBuilder = New-Object System.Text.StringBuilder 256
    [void][GlasshopperNativeWindows]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    [void][GlasshopperNativeWindows]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)

    $title = $titleBuilder.ToString()
    $className = $classBuilder.ToString()

    [uint32]$nativeProcessId = 0
    [void][GlasshopperNativeWindows]::GetWindowThreadProcessId($hWnd, [ref]$nativeProcessId)
    $processName = "unknown"
    try {
      $processName = (Get-Process -Id $nativeProcessId -ErrorAction Stop).ProcessName
    } catch {}

    $kind = Get-WindowKind $className $title $processName
    $isLikelyMsfs = $kind -match "^msfs-" -or $title -match "Flight Simulator|MSFS|Microsoft Flight"
    if (-not $includeAll -and -not $isLikelyMsfs) { return $true }

    $rect = New-Object GlasshopperNativeWindows+Rect
    $dwmRect = New-Object GlasshopperNativeWindows+Rect
    [void][GlasshopperNativeWindows]::GetWindowRect($hWnd, [ref]$rect)
    $dwmResult = [GlasshopperNativeWindows]::DwmGetWindowAttribute($hWnd, 9, [ref]$dwmRect, [Runtime.InteropServices.Marshal]::SizeOf($dwmRect))
    $effectiveRect = if ($dwmResult -eq 0 -and ($dwmRect.Right -gt $dwmRect.Left) -and ($dwmRect.Bottom -gt $dwmRect.Top)) { $dwmRect } else { $rect }

    $windows.Add([pscustomobject]@{
      handle = ("0x{0:X}" -f $hWnd.ToInt64())
      title = $title
      className = $className
      processId = [int]$nativeProcessId
      processName = $processName
      rect = Convert-Rect $effectiveRect
      isVisible = $true
      kind = $kind
    })
    return $true
  }, [IntPtr]::Zero) | Out-Null

  $windows
}

function Move-AgentWindow($payload) {
  Add-NativeWindowsType

  $handleText = [string]$payload.handle
  if (-not $handleText.StartsWith("0x")) {
    $handleText = "0x$handleText"
  }

  $handle = [IntPtr]::new([Convert]::ToInt64($handleText, 16))
  $insertAfter = if ($payload.alwaysOnTop) { -1 } else { -2 }
  [void][GlasshopperNativeWindows]::ShowWindow($handle, 9)
  $ok = [GlasshopperNativeWindows]::SetWindowPos(
    $handle,
    [IntPtr]::new($insertAfter),
    [int]$payload.rect.x,
    [int]$payload.rect.y,
    [int]$payload.rect.width,
    [int]$payload.rect.height,
    0x0040
  )

  if (-not $ok) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "SetWindowPos failed with Win32 error $code"
  }

  [pscustomobject]@{ ok = $true }
}

function Set-AgentWindowTitle($payload) {
  Add-NativeWindowsType

  $handleText = [string]$payload.handle
  if (-not $handleText.StartsWith("0x")) {
    $handleText = "0x$handleText"
  }
  if ([string]::IsNullOrWhiteSpace([string]$payload.title)) {
    throw "Window title cannot be empty."
  }

  $handle = [IntPtr]::new([Convert]::ToInt64($handleText, 16))
  $ok = [GlasshopperNativeWindows]::SetWindowText($handle, [string]$payload.title)
  if (-not $ok) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "SetWindowText failed with Win32 error $code"
  }

  [pscustomobject]@{ ok = $true }
}

function Get-MsfsProcesses {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match "FlightSimulator2024|FlightSimulator|Limitless|MSFS|couatl64_MSFS2024|CP MSFS Bridge" } |
    ForEach-Object {
      [pscustomobject]@{
        processId = $_.Id
        processName = $_.ProcessName
        mainWindowHandle = ("0x{0:X}" -f $_.MainWindowHandle.ToInt64())
        mainWindowTitle = $_.MainWindowTitle
        responding = $_.Responding
      }
    }
}

function Find-SimConnectManagedDll {
  $candidates = @(
    "C:\MSFS 2024 SDK\SimConnect SDK\lib\managed\Microsoft.FlightSimulator.SimConnect.dll",
    "C:\MSFS SDK\SimConnect SDK\lib\managed\Microsoft.FlightSimulator.SimConnect.dll"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }

  return $null
}

function Invoke-SimConnectProbe {
  $managedDll = Find-SimConnectManagedDll
  if (-not $managedDll) {
    return [pscustomobject]@{
      available = $false
      connected = $false
      error = "Microsoft.FlightSimulator.SimConnect.dll was not found. Install the MSFS 2024 SDK or set up a bundled SimConnect runtime."
    }
  }

  $sdkLib = Split-Path (Split-Path $managedDll -Parent) -Parent
  $oldPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
  [Environment]::SetEnvironmentVariable("PATH", "$sdkLib;$oldPath", "Process")

  Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class GlasshopperNativeLibraryPath {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetDllDirectory(string lpPathName);
}
"@ -ErrorAction SilentlyContinue
  [void][GlasshopperNativeLibraryPath]::SetDllDirectory($sdkLib)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -Path $managedDll

  $source = @"
using System;
using System.Windows.Forms;
using Microsoft.FlightSimulator.SimConnect;

public class GlasshopperSimProbe : Form {
  private const int WM_USER_SIMCONNECT = 0x0402;

  private enum DataDefinition {
    Required = 1
  }

  private enum DataRequest {
    Required = 1
  }

  private enum SystemStateRequest {
    AircraftPath = 100
  }

  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Ansi, Pack = 1)]
  public struct RequiredData {
    public double CameraState;
    public double CameraViewTypeAndIndex0;
    public double CameraViewTypeAndIndex1;
    public double CameraViewTypeAndIndex1Max;
    public double CameraViewTypeAndIndex2Max;
  }

  public bool Connected { get; private set; }
  public string Error { get; private set; }
  public string AircraftPath { get; private set; }
  public double? CameraState { get; private set; }
  public double? CameraViewTypeAndIndex0 { get; private set; }
  public double? CameraViewTypeAndIndex1 { get; private set; }
  public double? CameraViewTypeAndIndex1Max { get; private set; }
  public double? CameraViewTypeAndIndex2Max { get; private set; }

  private SimConnect simConnect;

  public void Start() {
    try {
      CreateControl();
      simConnect = new SimConnect("Glasshopper", Handle, WM_USER_SIMCONNECT, null, 0);
      simConnect.OnRecvOpen += (sender, data) => { Connected = true; };
      simConnect.OnRecvQuit += (sender, data) => { Connected = false; };
      simConnect.OnRecvException += (sender, data) => { Error = ((SIMCONNECT_EXCEPTION)data.dwException).ToString(); };
      simConnect.OnRecvSystemState += (sender, data) => { AircraftPath = data.szString; };
      simConnect.OnRecvSimobjectDataBytype += OnRecvSimobjectDataByType;

      simConnect.AddToDataDefinition(DataDefinition.Required, "CAMERA STATE", "Enum", SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
      simConnect.AddToDataDefinition(DataDefinition.Required, "CAMERA VIEW TYPE AND INDEX:0", "Number", SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
      simConnect.AddToDataDefinition(DataDefinition.Required, "CAMERA VIEW TYPE AND INDEX:1", "Number", SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
      simConnect.AddToDataDefinition(DataDefinition.Required, "CAMERA VIEW TYPE AND INDEX MAX:1", "Number", SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
      simConnect.AddToDataDefinition(DataDefinition.Required, "CAMERA VIEW TYPE AND INDEX MAX:2", "Number", SIMCONNECT_DATATYPE.FLOAT64, 0.0f, SimConnect.SIMCONNECT_UNUSED);
      simConnect.RegisterDataDefineStruct<RequiredData>(DataDefinition.Required);

      simConnect.RequestSystemState(SystemStateRequest.AircraftPath, "AircraftLoaded");
      simConnect.RequestDataOnSimObjectType(DataRequest.Required, DataDefinition.Required, 0, SIMCONNECT_SIMOBJECT_TYPE.USER);
    } catch (Exception ex) {
      Error = ex.Message;
    }
  }

  protected override void DefWndProc(ref Message m) {
    if (m.Msg == WM_USER_SIMCONNECT && simConnect != null) {
      try {
        simConnect.ReceiveMessage();
      } catch (Exception ex) {
        Error = ex.Message;
      }
    } else {
      base.DefWndProc(ref m);
    }
  }

  public void Pump(int milliseconds) {
    var until = DateTime.UtcNow.AddMilliseconds(milliseconds);
    while (DateTime.UtcNow < until) {
      Application.DoEvents();
      System.Threading.Thread.Sleep(25);
    }
  }

  public void CloseProbe() {
    if (simConnect != null) {
      simConnect.Dispose();
      simConnect = null;
    }
  }

  private void OnRecvSimobjectDataByType(SimConnect sender, SIMCONNECT_RECV_SIMOBJECT_DATA_BYTYPE data) {
    if (data.dwRequestID != (uint)DataRequest.Required) { return; }
    var received = (RequiredData)data.dwData[0];
    CameraState = received.CameraState;
    CameraViewTypeAndIndex0 = received.CameraViewTypeAndIndex0;
    CameraViewTypeAndIndex1 = received.CameraViewTypeAndIndex1;
    CameraViewTypeAndIndex1Max = received.CameraViewTypeAndIndex1Max;
    CameraViewTypeAndIndex2Max = received.CameraViewTypeAndIndex2Max;
  }
}
"@

  Add-Type -TypeDefinition $source -ReferencedAssemblies @("System.dll", "System.Windows.Forms.dll", $managedDll) -ErrorAction SilentlyContinue

  $probe = New-Object GlasshopperSimProbe
  try {
    $probe.Start()
    $probe.Pump(2500)

    $aircraftName = $null
    if ($probe.AircraftPath) {
      $tokens = $probe.AircraftPath.Split("\")
      if ($tokens.Length -gt 1) {
        $aircraftName = $tokens[$tokens.Length - 2]
        if ($aircraftName -ieq "config" -and $tokens.Length -gt 2) {
          $aircraftName = $tokens[$tokens.Length - 3]
        }
        $aircraftName = $aircraftName.Replace("_", " ").ToUpperInvariant()
      }
    }

    [pscustomobject]@{
      available = $true
      connected = [bool]$probe.Connected
      sdkPath = $managedDll
      aircraftPath = $probe.AircraftPath
      aircraftName = $aircraftName
      cameraState = if ($probe.CameraState.HasValue) { [int]$probe.CameraState.Value } else { $null }
      cameraViewTypeAndIndex0 = if ($probe.CameraViewTypeAndIndex0.HasValue) { [int]$probe.CameraViewTypeAndIndex0.Value } else { $null }
      cameraViewTypeAndIndex1 = if ($probe.CameraViewTypeAndIndex1.HasValue) { [int]$probe.CameraViewTypeAndIndex1.Value } else { $null }
      cameraViewTypeAndIndex1Max = if ($probe.CameraViewTypeAndIndex1Max.HasValue) { [int]$probe.CameraViewTypeAndIndex1Max.Value } else { $null }
      cameraViewTypeAndIndex2Max = if ($probe.CameraViewTypeAndIndex2Max.HasValue) { [int]$probe.CameraViewTypeAndIndex2Max.Value } else { $null }
      error = $probe.Error
    }
  } finally {
    $probe.CloseProbe()
    $probe.Dispose()
  }
}

try {
  $payload = $PayloadJson | ConvertFrom-Json

  switch ($GlasshopperCommand) {
    "displays" {
      Write-AgentResult @(Get-Displays)
      break
    }
    "windows" {
      Write-AgentResult @(Get-Windows ([bool]$payload.includeAll))
      break
    }
    "msfs-processes" {
      Write-AgentResult @(Get-MsfsProcesses)
      break
    }
    "sim-state" {
      Write-AgentResult (Invoke-SimConnectProbe)
      break
    }
    "move-window" {
      Write-AgentResult (Move-AgentWindow $payload)
      break
    }
    "set-title" {
      Write-AgentResult (Set-AgentWindowTitle $payload)
      break
    }
    default {
      throw "Unknown Windows agent command: $GlasshopperCommand"
    }
  }
} catch {
  $detail = $_.Exception.Message
  if ($Error.Count -gt 0) {
    $details = @()
    foreach ($item in @($Error | Select-Object -First 8)) {
      $details += $item.ToString()
      if ($item.Exception -and $item.Exception.Message) {
        $details += $item.Exception.Message
      }
      if ($item.ErrorDetails -and $item.ErrorDetails.Message) {
        $details += $item.ErrorDetails.Message
      }
    }
    $joined = ($details | Where-Object { $_ } | Select-Object -Unique) -join " "
    if ($joined -and $joined -ne $detail) {
      $detail = "$detail $joined"
    }
  }
  Write-AgentError $detail
  exit 0
}
