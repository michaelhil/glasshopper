import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyProfile,
  bindPanelSource,
  getAppState,
  preflightProfile,
  removePanel,
  renamePanel,
  updateLayoutFromCurrent
} from "./app-core.ts";
import { toErrorMessage } from "./errors.ts";
import { createPlatformAdapter } from "./platform/windows.ts";
import { autoReopenPanel, CaptureListener } from "./capture.ts";

const resolveUiDir = (): string => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "ui"),
    join(process.cwd(), "src", "ui"),
    join(process.cwd(), "ui")
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0]!;
};

const uiDir = resolveUiDir();
const port = Number(process.env["GLASSHOPPER_UI_PORT"] ?? "32024");
const listener = new CaptureListener();

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const readJson = async <T>(request: Request): Promise<T> => {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
};

const getProfileName = (url: URL): string => url.searchParams.get("profile") || "a320";

const staticFile = async (pathname: string): Promise<Response> => {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const path = join(uiDir, normalized.replace(/^\/+/, ""));
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file);
};

const routeApi = async (request: Request, url: URL): Promise<Response> => {
  if (request.method === "GET" && url.pathname === "/api/state") {
    return json({
      ...(await getAppState(getProfileName(url))),
      listener: listener.snapshot()
    });
  }

  if (request.method === "POST" && url.pathname === "/api/listen/start") {
    const body = await readJson<{
      readonly profile?: string;
      readonly display?: string;
      readonly topmost?: boolean;
    }>(request);
    await listener.start({
      profileName: body.profile || "a320",
      displayArg: body.display || "0",
      alwaysOnTop: body.topmost ?? true
    });
    return json(listener.snapshot());
  }

  if (request.method === "POST" && url.pathname === "/api/listen/stop") {
    listener.stop();
    return json(listener.snapshot());
  }

  if (request.method === "POST" && url.pathname === "/api/preflight") {
    const body = await readJson<{ readonly profile?: string }>(request);
    return json(await preflightProfile(body.profile || "a320"));
  }

  if (request.method === "POST" && url.pathname === "/api/apply") {
    const body = await readJson<{ readonly profile?: string; readonly dryRun?: boolean }>(request);
    return json({ messages: await applyProfile(body.profile || "a320", body.dryRun ?? false) });
  }

  if (request.method === "POST" && url.pathname === "/api/layout/from-current") {
    const body = await readJson<{ readonly profile?: string; readonly display?: string }>(request);
    const count = await updateLayoutFromCurrent(createPlatformAdapter(), body.profile || "a320", body.display || "0");
    return json({ count });
  }

  if (request.method === "POST" && url.pathname === "/api/panel/delete") {
    const body = await readJson<{ readonly profile?: string; readonly name?: string }>(request);
    if (!body.name) {
      return json({ error: "Missing panel name." }, 400);
    }
    await removePanel(body.profile || "a320", body.name);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/panel/rename") {
    const body = await readJson<{ readonly profile?: string; readonly name?: string; readonly nextName?: string }>(request);
    if (!body.name || !body.nextName) {
      return json({ error: "Missing panel name." }, 400);
    }
    await renamePanel(body.profile || "a320", body.name, body.nextName);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/panel/bind-source") {
    const body = await readJson<{
      readonly profile?: string;
      readonly name?: string;
      readonly timeoutMs?: number;
      readonly clickMethod?: "altGrClick" | "ctrlClick";
    }>(request);
    if (!body.name) {
      return json({ error: "Missing panel name." }, 400);
    }
    return json({
      panel: await bindPanelSource(
        body.profile || "a320",
        body.name,
        body.timeoutMs ?? 30000,
        body.clickMethod || "altGrClick"
      )
    });
  }

  if (request.method === "POST" && url.pathname === "/api/panel/auto-reopen") {
    const body = await readJson<{
      readonly profile?: string;
      readonly name?: string;
      readonly display?: string;
    }>(request);
    if (!body.name) {
      return json({ error: "Missing panel name." }, 400);
    }
    const reopenRequest: {
      profileName: string;
      panelName: string;
      displayArg?: string;
      alwaysOnTop: boolean;
    } = {
      profileName: body.profile || "a320",
      panelName: body.name,
      alwaysOnTop: true
    };
    if (body.display) {
      reopenRequest.displayArg = body.display;
    }
    return json({ result: await autoReopenPanel(reopenRequest) });
  }

  return json({ error: "Unknown API route." }, 404);
};

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await routeApi(request, url);
      }
      return await staticFile(url.pathname);
    } catch (error) {
      return json({ error: toErrorMessage(error) }, 500);
    }
  }
});

console.log(`Glasshopper UI: http://localhost:${port}`);
