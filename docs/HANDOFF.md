# Glasshopper Handoff

Date: 2026-05-27

This document captures what worked during the first live MSFS 2024/Fenix A320 session, what failed, how we fixed it, and where to take Glasshopper next.

## Current Working Shape

Glasshopper is still a Bun/TypeScript CLI, but it now has a Windows agent boundary:

- TypeScript owns CLI flow, profiles, matching, and user-facing diagnostics.
- `src/platform/windows-agent.ps1` owns Win32, DWM, DPI awareness, window enumeration, window movement, title changes, process detection, and the current SimConnect probe.
- Normal PowerShell is the reliable runtime for live MSFS testing.

Known good live workflow:

```powershell
bun run glasshopper panels --profile a320
bun run glasshopper bring-in
bun run glasshopper adopt --profile a320 --topmost
bun run glasshopper layout --profile a320 --from-current
bun run glasshopper preflight --profile a320
bun run glasshopper apply --profile a320
```

For a guided first pass:

```powershell
bun run glasshopper setup --profile a320 --topmost
```

The profile name is aircraft/user chosen. Nothing in the commands is A320-specific.

## What Worked

### Normal PowerShell Can See MSFS

Codex's sandboxed execution context could see MSFS processes but could not enumerate interactive desktop windows and could not connect SimConnect. A normal PowerShell window did both.

Symptoms inside Codex:

```text
FlightSimulator2024(... ) handle=0x0
discover --all -> no windows
SimConnect -> E_FAIL
```

Symptoms from normal PowerShell:

```text
SimConnect: connected
aircraft: FNX 320 CFM SL
AceApp windows visible
```

Conclusion: live MSFS tests must run from normal PowerShell, or a future companion UI/helper must run in the user's interactive desktop context.

### SimConnect Is Useful, But Not For Direct Pop-Out Creation

SimConnect connected from normal PowerShell and identified the current aircraft:

```text
FNX 320 CFM SL
```

It is useful for aircraft/session/camera readiness. It does not appear to expose a clean "pop out this glass display" API. The realistic flow remains:

1. User or automation invokes the MSFS "new UI window" gesture.
2. Glasshopper detects the new `AceApp` pop-out.
3. Glasshopper names, places, and manages that window.

### MSFS/Fenix Pop-Outs Are `AceApp` Windows

The live Fenix A320 session exposed:

```text
FlightSimulator2024
class: AceApp
title: WASMINSTRUMENT
title: FENIXWASMINSTRUMENT
```

The main sim window is also `AceApp`, so always exclude:

```text
kind: msfs-main
```

Never bulk move or rename the main MSFS window.

### DPI Awareness Was Mandatory

Before `SetProcessDPIAware`, display bounds were reported as:

```text
4096x1728
```

while windows were in:

```text
5120x2160
```

After calling `SetProcessDPIAware` in the agent, display/window coordinates matched.

### Offscreen Pop-Outs Are Common

New pop-outs appeared at:

```text
y=2160
```

On a `5120x2160` display, that means the top edge is exactly offscreen. The `bring-in` command now stages offscreen MSFS pop-outs into visible space.

### Duplicate Titles Are Normal

Fenix produced multiple windows titled:

```text
WASMINSTRUMENT
```

Raw title matching is not sufficient. Glasshopper now uses the convention:

```text
Glasshopper:<profile>:<panel>
```

Example:

```text
Glasshopper:a320:pfd-capt
Glasshopper:a320:nd-capt
Glasshopper:a320:ecam
```

Profiles created by `identify`/`adopt` use `titleExact`, process name, and class name.

## Problems And Fixes

### PowerShell `$PID` Collision

The Windows agent originally used `$pid` as an output variable for `GetWindowThreadProcessId`. PowerShell variables are case-insensitive, and `$PID` is built in and read-only.

Failure:

```text
Cannot overwrite variable PID because it is read-only or constant.
```

Fix:

```powershell
$nativeProcessId
```

### App Control Blocked Rebuilt Executable

After rebuilding `dist/glasshopper.exe`, Windows Application Control blocked the changed binary hash:

```text
An Application Control policy has blocked this file
```

Workaround:

```powershell
bun run glasshopper ...
```

Future fix: sign the executable or create an installer/build path that is approved by the user's Application Control policy.

### Stale Profile Entries Blocked Layout/Preflight

Old substring-based profile entries remained after switching to exact titles:

```text
wasminstrument
fenixwasminstrument
```

Fixes added:

```powershell
bun run glasshopper remove --profile a320 --name wasminstrument
bun run glasshopper repair --profile a320 --prune
```

### `panels` Initially Over-Claimed Profile Matches

Because profile matching used substrings, `panels --profile a320` marked unrelated duplicate windows as profiled. It now only marks a window as profiled if the profile entry resolves uniquely to that exact handle.

## Current Commands

### Diagnostics

```powershell
bun run glasshopper doctor
bun run glasshopper sim-state
bun run glasshopper discover --all
bun run glasshopper panels --profile <profile>
```

### Window Recovery

```powershell
bun run glasshopper bring-in --dry-run
bun run glasshopper bring-in
```

### Profile Authoring

```powershell
bun run glasshopper identify --profile <profile> --handle 0xHANDLE --name <panel> --topmost
bun run glasshopper adopt --profile <profile> --topmost
bun run glasshopper layout --profile <profile> --from-current
bun run glasshopper setup --profile <profile> --topmost
```

### Profile Maintenance

```powershell
bun run glasshopper profile list
bun run glasshopper profile show --profile <profile>
bun run glasshopper repair --profile <profile>
bun run glasshopper repair --profile <profile> --prune
bun run glasshopper remove --profile <profile> --name <panel>
```

### Apply

```powershell
bun run glasshopper preflight --profile <profile>
bun run glasshopper apply --profile <profile> --dry-run
bun run glasshopper apply --profile <profile>
```

## Suggested UI Direction

The next phase should stop feeling like a collection of scripts. Keep the current commands as the automation core, but build an interactive shell or desktop UI around the same primitives.

Recommended first UI:

1. A small local desktop app or TUI launched from normal PowerShell.
2. Left pane: profiles and current aircraft.
3. Main pane: detected pop-out panels as cards.
4. Each card shows:
   - current title
   - stable Glasshopper name, if any
   - onscreen/offscreen
   - duplicate-title warning
   - current rect
   - profile match state
5. Actions:
   - Bring in offscreen panels
   - Identify/name selected panel
   - Flash selected panel
   - Save current layout
   - Preflight
   - Apply

The important UI trick is "show me which window this is." Add a flash/highlight operation before building a full graphical profile editor. A simple temporary move/resize or border overlay would solve most ambiguity.

## Architecture Direction

### Keep

- TypeScript profile and orchestration logic.
- Windows agent boundary.
- Exact custom titles.
- Preflight-first behavior.
- `bring-in` as recovery primitive.

### Improve

- Move the PowerShell-hosted C# into a real signed helper executable.
- Keep the helper in the interactive desktop context.
- Add a persistent helper process for:
  - WinEvent hooks
  - new pop-out detection
  - SimConnect message pump
  - panel flashing/highlighting
  - lower-latency operations

### Defer

- Fully automated cockpit clicking.
- Touch forwarding.
- Cropping/title-bar hiding beyond simple window title and topmost.

These are valuable, but the user-visible reliability now depends more on identity, recovery, and guided setup.

## Next Implementation Ideas

1. `watch` or `popout-watch`
   - User AltGr-clicks a panel.
   - Glasshopper detects the new pop-out.
   - It brings it in, flashes it, and asks for a name.

2. `flash --handle`
   - Temporarily move/resize or draw a border around one window so the user can identify it.

3. `profile bind-aircraft`
   - Store current SimConnect aircraft in the profile.
   - Warn if applying a profile to the wrong aircraft.

4. UI/TUI mode
   - Make setup a guided state machine.
   - Commands remain usable and testable underneath.

5. Packaging
   - Signed helper/exe.
   - Clear installer story.
   - Avoid Application Control hash churn pain.

## Known Good Live Test From Today

The user successfully:

1. Popped out three Fenix A320 displays.
2. Ran `bring-in`.
3. Identified three panels:

```text
pfd-capt
nd-capt
ecam
```

4. Saved layout from current windows.
5. Passed preflight.
6. Ran dry-run apply:

```text
Ready pfd-capt -> LG ULTRAGEAR+
Ready nd-capt -> LG ULTRAGEAR+
Ready ecam -> LG ULTRAGEAR+
```

This is the baseline to preserve.
