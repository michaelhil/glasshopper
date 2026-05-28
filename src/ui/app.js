const state = {
  profile: "a320",
  display: "0",
  data: null
};

const $ = (id) => document.getElementById(id);

const log = (message) => {
  const now = new Date().toLocaleTimeString();
  $("log").textContent = `[${now}] ${message}\n${$("log").textContent}`;
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
};

const panelCard = (panel, saved) => {
  const el = document.createElement("div");
  el.className = "panel";

  const status = saved ? panel.status : panel.profiledAs ? "profiled" : "unprofiled";
  const title = saved ? panel.name : panel.window.title || "(untitled)";
  const hasStrongSource = Boolean(panel.source && panel.source.cameraState != null && panel.source.cameraViewTypeAndIndex0 != null && panel.source.cameraViewTypeAndIndex1 != null);
  const isChasePlaneSource = panel.source?.cameraProvider === "chaseplane" || Boolean(state.data?.chasePlane?.detected && panel.source && !hasStrongSource);
  const sourceLabel = panel.source
    ? isChasePlaneSource
      ? `chaseplane-source${panel.source.chasePlaneBridgeConnected ? "" : "-offline"}`
      : hasStrongSource
        ? "source-bound"
        : "weak-source"
    : "no-source";
  const meta = saved
    ? `${panel.displayName || "no display"} ${panel.liveHandle || ""} ${sourceLabel} ${panel.error || ""}`
    : `${panel.window.handle} ${panel.onscreen ? "onscreen" : "offscreen"} ${panel.window.rect.x},${panel.window.rect.y} ${panel.window.rect.width}x${panel.window.rect.height}`;

  el.innerHTML = `
    <div>
      <div class="panel-title">${title} <span class="badge ${status}">${status}</span></div>
      <div class="meta">${meta}</div>
    </div>
    <div class="panel-actions"></div>
  `;

  const actions = el.querySelector(".panel-actions");
  if (saved) {
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.addEventListener("click", async () => {
      const nextName = prompt("Panel name", panel.name);
      if (!nextName || nextName === panel.name) {
        return;
      }
      await api("/api/panel/rename", {
        method: "POST",
        body: JSON.stringify({ profile: state.profile, name: panel.name, nextName })
      });
      log(`Renamed ${panel.name} to ${nextName}.`);
      await refresh();
    });
    actions.append(rename);

    if (!panel.source) {
      const bind = document.createElement("button");
      bind.type = "button";
      bind.textContent = "Bind Source";
      bind.addEventListener("click", async () => {
        try {
          log(`Waiting for source click for ${panel.name}. Click the cockpit panel in MSFS.`);
          await api("/api/panel/bind-source", {
            method: "POST",
            body: JSON.stringify({ profile: state.profile, name: panel.name, timeoutMs: 30000, clickMethod: "altGrClick" })
          });
          log(`Bound source for ${panel.name}.`);
          await refresh();
        } catch (error) {
          log(error.message);
        }
      });
      actions.append(bind);
    }

    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.textContent = panel.source ? "Auto Reopen" : "Recapture";
    reopen.addEventListener("click", async () => {
      try {
        if (!panel.source) {
          log(`${panel.name} has no source binding yet. Use + capture or Bind Source first.`);
          return;
        }
        if (!hasStrongSource && !isChasePlaneSource) {
          log(`${panel.name} has only a weak source. Auto Reopen needs camera data, so recapture this panel with + after the camera probe is fixed.`);
          return;
        }
        if (!confirm(`Focus MSFS and click the saved source for ${panel.name}?`)) {
          return;
        }
        log(`Trying Auto Reopen for ${panel.name}...`);
        const result = await api("/api/panel/auto-reopen", {
          method: "POST",
          body: JSON.stringify({ profile: state.profile, name: panel.name, display: state.display })
        });
        log(`Auto reopened ${panel.name} using ${result.result.handle}.`);
        await refresh();
      } catch (error) {
        log(error.message);
      }
    });
    actions.append(reopen);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${panel.name} from ${state.profile}?`)) {
        return;
      }
      await api("/api/panel/delete", {
        method: "POST",
        body: JSON.stringify({ profile: state.profile, name: panel.name })
      });
      log(`Deleted ${panel.name}.`);
      await refresh();
    });
    actions.append(remove);
  }

  return el;
};

const refresh = async () => {
  state.profile = $("profile").value.trim() || "a320";
  state.data = await api(`/api/state?profile=${encodeURIComponent(state.profile)}`);

  const sim = state.data.simState;
  $("sim-state").textContent = sim?.connected
    ? `SimConnect connected: ${sim.aircraftName || "aircraft unknown"}${state.data.chasePlane?.detected ? ` · ChasePlane ${state.data.chasePlane.bridgeConnected ? "bridge connected" : "detected"}` : ""}`
    : "SimConnect not connected";

  const display = $("display");
  const previous = display.value || state.display;
  display.replaceChildren();
  for (const item of state.data.displays) {
    const option = document.createElement("option");
    option.value = String(item.index);
    option.textContent = `[${item.index}] ${item.identity.friendlyName || item.identity.deviceName}`;
    display.append(option);
  }
  display.value = [...display.options].some((option) => option.value === previous) ? previous : "0";
  state.display = display.value;

  const listener = state.data.listener;
  $("listen").textContent = listener?.active ? "x" : "+";
  $("listen-status").textContent = listener?.active
    ? `Listening on display ${listener.displayArg}. Captured ${listener.captured.length}.${listener.pendingSource ? " Source click ready." : ""}`
    : listener?.lastError
      ? `Stopped: ${listener.lastError}`
      : "Listener stopped.";

  const saved = $("saved-panels");
  saved.replaceChildren();
  if (state.data.profilePanels.length === 0) {
    saved.innerHTML = `<div class="muted">No saved panels.</div>`;
  } else {
    for (const panel of state.data.profilePanels) {
      saved.append(panelCard(panel, true));
    }
  }

  const live = $("live-panels");
  live.replaceChildren();
  if (state.data.panels.length === 0) {
    live.innerHTML = `<div class="muted">No live pop-outs.</div>`;
  } else {
    for (const panel of state.data.panels) {
      live.append(panelCard(panel, false));
    }
  }
};

$("refresh").addEventListener("click", () => refresh().catch((error) => log(error.message)));
$("profile").addEventListener("change", () => refresh().catch((error) => log(error.message)));
$("display").addEventListener("change", () => {
  state.display = $("display").value;
});

$("preflight").addEventListener("click", async () => {
  try {
    const result = await api("/api/preflight", {
      method: "POST",
      body: JSON.stringify({ profile: state.profile })
    });
    log(result.ok ? "Preflight passed." : `Preflight failed:\n- ${result.failures.join("\n- ")}`);
  } catch (error) {
    log(error.message);
  }
});

$("apply").addEventListener("click", async () => {
  try {
    const result = await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({ profile: state.profile, dryRun: false })
    });
    log(result.messages.join("\n") || "Nothing applied.");
    await refresh();
  } catch (error) {
    log(error.message);
  }
});

$("save-layout").addEventListener("click", async () => {
  try {
    const result = await api("/api/layout/from-current", {
      method: "POST",
      body: JSON.stringify({ profile: state.profile, display: state.display })
    });
    log(`Saved layout for ${result.count} panel(s).`);
    await refresh();
  } catch (error) {
    log(error.message);
  }
});

$("listen").addEventListener("click", async () => {
  try {
    const active = state.data?.listener?.active;
    const result = await api(active ? "/api/listen/stop" : "/api/listen/start", {
      method: "POST",
      body: JSON.stringify({ profile: state.profile, display: state.display, topmost: true })
    });
    log(result.active ? "Listening for new pop-outs." : "Listener stopped.");
    await refresh();
  } catch (error) {
    log(error.message);
  }
});

refresh().catch((error) => log(error.message));
setInterval(() => refresh().catch(() => undefined), 3000);
