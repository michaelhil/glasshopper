# Glasshopper

Glasshopper is a small Windows-first proof of concept for placing Microsoft Flight Simulator 2024 pop-out windows on a chosen display.

Version `0.1.0` is intentionally narrow: it does not click cockpit panels, crop panels, use SimConnect, or modify MSFS files. It proves the foundation first:

- enumerate connected displays with stable identity metadata where Windows exposes it
- discover visible MSFS and pop-out windows
- save a simple placement profile
- move matching windows to a display with Win32 positioning

## Why This Shape

MSFS pop-out tooling tends to become fragile when it combines too many jobs at once: aircraft detection, cockpit camera movement, simulated clicks, panel cropping, touch forwarding, focus management, and window placement. Glasshopper starts with the part that must be reliable before anything else can be trusted: identifying displays and moving already-created pop-out windows.

The original MSFS Pop Out Panel Manager is a C# WPF app with many mature features, including profile automation, touch support, auto refocus, title-bar hiding, and auto-pop-out orchestration. Glasshopper is a clean-sheet TypeScript/Bun tool and only borrows the broad product lesson: profiles are useful, but v0.1 should fail conservatively instead of moving the wrong thing.

## Requirements

- Windows 10 or 11
- Microsoft Flight Simulator 2024
- Bun
- PowerShell 5 or newer

For development on macOS or Linux, set `GLASSHOPPER_MOCK=1` to exercise the CLI without touching real windows.

## Install

For the first proof of concept, install from source:

```powershell
bun install
bun run glasshopper doctor
```

To build a single Windows executable:

```powershell
bun run build:windows
.\dist\glasshopper.exe doctor
```

## Basic Workflow

1. Start MSFS 2024.
2. Manually pop out an instrument panel in MSFS.
3. Run discovery:

```powershell
bun run glasshopper discover
```

4. Save a placement. Use the display index or `stableId` from discovery:

```powershell
bun run glasshopper save --profile default --name pfd --display 1 --title "Flight Simulator" --x 0 --y 0 --width 1024 --height 768 --topmost
```

5. Apply the profile after future pop-outs:

```powershell
bun run glasshopper apply --profile default
```

If a saved profile matches zero windows or more than one window, Glasshopper stops and asks you to make the match more specific with `--title`, `--process`, or `--class`.

## Commands

```powershell
bun run glasshopper doctor
bun run glasshopper discover --all
bun run glasshopper move --handle 0x123456 --display 1 --x 0 --y 0 --width 1024 --height 768
bun run glasshopper save --profile default --name pfd --display 1 --title "Flight Simulator" --width 1024 --height 768
bun run glasshopper apply --profile default
```

Profiles are stored in `profiles/<name>.json`.

## Display Identity

Glasshopper stores several display identifiers:

- serial-backed `stableId` when Windows exposes monitor serial data
- WMI instance name when serial data is missing
- display fingerprint fallback based on Windows display name, bounds, resolution, and primary state

This is more robust than coordinates alone, but v0.1 still reports an identity confidence level because Windows and adapter drivers do not always expose EDID data cleanly. If a monitor is disconnected, `apply` fails rather than silently moving a panel to the wrong screen.

## v0.1 Boundaries

Included:

- display discovery
- MSFS-like window discovery
- manual profile save
- profile apply
- one-off window move
- conservative matching and display fallback

Deferred:

- SimConnect session and aircraft detection
- automatic cockpit click/pop-out orchestration
- panel cropping and title-bar hiding
- touch forwarding and focus recovery
- graphical profile editor
- installer packaging beyond Bun compile

## Release Notes

### 0.1.0

- Initial proof of concept for Windows display and MSFS pop-out window placement.
- TypeScript/Bun implementation with no application server.
- Windows APIs are accessed through PowerShell interop from TypeScript.
