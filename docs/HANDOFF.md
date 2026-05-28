# Glasshopper Handoff

Date: 2026-05-28

This document captures what worked during live MSFS 2024/Fenix A320 testing, what failed, how we fixed it, and where to take Glasshopper next. It is written so a future session on another machine can resume from the real state of the project.

## Current Working Shape

Glasshopper is now a Bun/TypeScript CLI plus a local Bun web UI:

- TypeScript owns CLI flow, profiles, matching, and user-facing diagnostics.
- `src/platform/windows-agent.ps1` owns Win32, DWM, DPI awareness, window enumeration, window movement, title changes, process detection, and the current SimConnect probe.
- `src/ui-server.ts` serves the local UI at `http://localhost:32024`.
- `src/capture.ts` owns the add-popout listener and Auto Reopen orchestration.
- `src/chaseplane.ts` detects Parallel 42 ChasePlane, its bridge, and its saved view data.
- Normal PowerShell or an elevated Bun process is the reliable runtime for live MSFS testing because sandboxed processes may not see the interactive desktop or `%APPDATA%` folders.

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

Current local UI workflow:

```powershell
bun run ui
```

Then open:

```text
http://localhost:32024
```

The UI can:

- list current pop-outs and saved panels
- keep Add Popout listening while the user creates multiple panels
- auto-bind source clicks when Add Popout is active
- close/delete saved panel entries
- apply saved placement
- attempt Auto Reopen for closed panels
- show SimConnect and ChasePlane detection state

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

## UI And Auto Reopen State

The Bun local UI exists and is the preferred test surface for now. It avoids command-line ceremony while keeping the CLI primitives underneath.

Important behavior:

- The `+` / Add Popout listener watches for new MSFS pop-out windows.
- While Add Popout is active, Glasshopper also listens for the cockpit click that produced the pop-out and stores that as `source`.
- If the user closes a captured pop-out with the window `X`, the saved panel remains in the UI and `Apply` can still place an existing matching window. `Auto Reopen` attempts to recreate the window by returning to the source click and then recapturing the new pop-out.
- The old manual `Bind Source` button was kept while testing, but source binding is now mostly automatic when Add Popout is active. It should probably be removed or demoted to an advanced repair action once the UI is cleaned up.

Current Auto Reopen limitation:

- It can foreground MSFS and click the saved screen coordinate.
- It works only if the simulator is already looking at the same cockpit source area.
- With ChasePlane active, stock MSFS camera variables are not enough to restore that source view.

## ChasePlane Deep Dive

The user uses Parallel 42 ChasePlane, which takes over the default MSFS camera system. That is the likely reason Auto Reopen reached MSFS but did not recreate closed pop-outs.

Local ChasePlane artifacts found on the test machine:

```text
%APPDATA%\Microsoft Flight Simulator 2024\Packages\Community\p42-util-chaseplane
%APPDATA%\Microsoft Flight Simulator 2024\WASM\MSFS2024\p42-util-chaseplane\work
%LOCALAPPDATA%\Programs\Parallel 42\ChasePlane\V2\MSFS2024\Logs\cp_log.txt
```

Local bridge:

```text
ws://localhost:8652
http://localhost:8651/
```

Process:

```text
CP MSFS Bridge
```

The websocket can be connected to from Bun and sends heartbeat/status traffic such as:

```text
CP_PING::
INPUT_MOUSE_CAPTURE
CAM_DRAG_SET::1
CAM_DRAG_SET::0
MOVE_INHIBIT_UI::1
MOVE_INHIBIT_UI::0
CAM_PRESET_LOAD::0,<guid>,camera_preset_strip
CAM_MODE_SET::0,<guid>,NULL,NULL,0,1,1,1,1
```

Observed Fenix A320 ChasePlane views:

```text
Pilot          beacfc1a-0000-0000-aead-4bd970aae699
Copilot        2afd0a6d-0000-0000-9336-42cd7dd7cd6a
MCDU Captain   e4c11872-0000-0000-87fb-49feaaa72bbf
MCDU FO        9af8e6de-0000-0000-ba97-4302762b44c8
EFB Captain    3cc5d0e8-0000-0000-938e-43a7e12ba082
FCU            35214b50-0000-0000-806b-4417e850f9c7
Pedestal       a04c75f8-0000-0000-b322-4c495db125a1
```

The view JSON files include:

```text
guid
mode
name
index
aircraft
position { x, y, z, yaw, roll, zoom, pitch }
shortcuts
profile_theme
profile_preset
aircraft_readable
profile_physics_type
```

ChasePlane user settings showed:

```json
"enable_3rd_party_plugins": true
```

So the third-party plugin toggle was already enabled.

### Key Finding

The ChasePlane websocket is useful for observation, but direct desktop clients could not command camera changes by replaying the observed messages.

Tested and did not work:

```text
CAM_PRESET_LOAD::<guid>
CAM_MODE_SET::0
CAM_PRESET_LOAD::0,<guid>,camera_preset_strip
CAM_MODE_SET::0,<guid>,NULL,NULL,0,1,1,1,1
CP_INIT + WASM_PING + VERSION + UINFO + TOOLBAR_READY + view load
```

Those commands did not appear in `cp_log.txt` as accepted `load_preset` actions, and the camera did not visibly jump.

The ChasePlane panel script shows in-sim comms channels:

```text
p42_chaseplane_comms_api
p42_chaseplane_api_forward
p42_chaseplane_api_reply
p42_chaseplane_comms_event
COMM_BUS_WASM_CALLBACK
API_REPLY
```

It also includes text for "Enable 3rd party plugins" and says external applications/plugins can connect and control ChasePlane via API connections. The practical evidence suggests that a true in-sim plugin/panel path is needed, not a plain external websocket echo.

FSRealistic+ likely succeeds with ChasePlane because it is now a native in-sim MSFS 2024 panel/plugin and can use ChasePlane's internal communication path, rather than relying on a normal desktop process.

## Recommended Next Step: Glasshopper MSFS Helper

Build a tiny Glasshopper Community package / in-sim helper panel.

Goal:

- Keep the Bun UI as the user's desktop control surface.
- Add an in-sim helper that can talk to ChasePlane through the same in-sim comms/event bus the ChasePlane panel expects.
- Let the desktop UI ask the helper to load a ChasePlane view, then perform the pop-out click and window placement from the existing Windows agent.

Expected architecture:

```text
Bun UI / CLI
  -> local Glasshopper helper websocket or HTTP endpoint
  -> MSFS in-sim Glasshopper panel / WASM helper
  -> ChasePlane in-sim comms/API channel
  -> ChasePlane loads saved view
  -> Windows agent performs modified click at saved source coordinate
  -> Glasshopper captures and places the new pop-out
```

For each saved panel source, store:

```text
cameraProvider: chaseplane
chasePlaneViewGuid
chasePlaneViewName
chasePlaneViewMode
source screen x/y
click method
aircraft slug/path
```

Auto Reopen flow with helper:

1. Validate MSFS, SimConnect, and ChasePlane are running.
2. Validate the saved aircraft/profile matches the current aircraft.
3. Ask the helper to load the saved ChasePlane view by GUID.
4. Wait for a positive helper reply, or watch the ChasePlane bridge/log for the expected `CAM_PRESET_LOAD`.
5. Wait a short configurable settle time.
6. Foreground MSFS and send the saved AltGr/Ctrl click.
7. Watch for a new pop-out.
8. Rename, move, and set topmost according to the saved panel profile.

Fallbacks if helper control is not available:

- Let the user manually select the saved ChasePlane view, then press Auto Reopen.
- Support a "guided reopen" mode that shows the saved target coordinate and waits for the user to put the view in place.
- Investigate shortcut assignment as a fallback, but do not mutate the user's ChasePlane view JSON unless the UI asks permission. Existing shortcuts are device-specific strings and not simple keyboard accelerators.

Stress points for the helper:

- ChasePlane may change internal event names or payloads.
- MSFS in-sim panels may be disabled or not loaded early in a flight.
- Fullscreen MSFS focus rules can block or swallow synthetic input.
- View load may be asynchronous; do not click immediately after sending a view command.
- View GUIDs are per aircraft/profile. Never reuse across a different aircraft without validation.
- Users may rename or delete ChasePlane views after binding; handle missing GUIDs with a clear repair prompt.

## Next Implementation Plan

1. Add ChasePlane source schema fields.
   - Extend `PanelSourceBinding` with optional ChasePlane view GUID/name/mode.
   - During Add Popout, capture the most recent ChasePlane `CAM_PRESET_LOAD` observed on the bridge and attach it to the pending source.

2. Improve the UI source display.
   - Show "ChasePlane view: MCDU Captain" when bound.
   - Hide or demote manual Bind Source when automatic source exists.
   - Add a repair action for missing source or missing view.

3. Prototype helper package.
   - Minimal MSFS Community package that loads an invisible/small Glasshopper panel.
   - Register with the MSFS toolbar/event bus.
   - Send and receive messages through a local bridge or SimConnect/LVar path.
   - Prove one command: "load ChasePlane view GUID".

4. Wire helper into Auto Reopen.
   - If `cameraProvider === "chaseplane"` and helper is connected, load view through helper before clicking.
   - If helper is missing, show "manual view required" instead of silently failing.

5. Package/distribution.
   - Bun UI executable for the desktop side.
   - Glasshopper Community package installer/copy step for the MSFS helper.
   - Eventually sign the Windows helper/exe to avoid Application Control hash churn.

## How To Resume On Another Machine

1. Clone the repo and install:

```powershell
git clone https://github.com/michaelhil/glasshopper.git
cd glasshopper
bun install
```

2. Run checks:

```powershell
bun run check
bun run glasshopper doctor
```

3. Start MSFS 2024 and ChasePlane, load into an aircraft.

4. Start the UI from a normal/elevated PowerShell if AppData/desktop visibility is needed:

```powershell
bun run ui
```

5. Open:

```text
http://localhost:32024
```

6. If debugging ChasePlane, use a watcher that connects to `ws://localhost:8652` and tails:

```text
%LOCALAPPDATA%\Programs\Parallel 42\ChasePlane\V2\MSFS2024\Logs\cp_log.txt
%APPDATA%\Microsoft Flight Simulator 2024\WASM\MSFS2024\p42-util-chaseplane\work\wasm.log
```

7. Use Add Popout to bind source clicks while creating panels. Do not expect ChasePlane Auto Reopen to fully work until the helper exists.
