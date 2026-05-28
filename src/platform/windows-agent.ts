import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayInfo, MoveWindowRequest, ProcessInfo, SimState, WindowInfo } from "../types.ts";

export interface CapturedClick {
  readonly x: number;
  readonly y: number;
}

interface AgentResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

const agentPath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "windows-agent.ps1"),
    join(process.cwd(), "src", "platform", "windows-agent.ps1"),
    join(process.cwd(), "..", "src", "platform", "windows-agent.ps1")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Windows agent script was not found. Checked: ${candidates.join(", ")}`);
  }

  return found;
};

const runAgent = async <T>(
  command: string,
  payload: Record<string, unknown> = {}
): Promise<T> => {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    agentPath(),
    "-GlasshopperCommand",
    command,
    "-PayloadJson",
    JSON.stringify(payload)
  ];

  return await new Promise<T>((resolve, reject): void => {
    const child = spawn("powershell.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer): void => {
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer): void => {
      stderr.push(chunk);
    });

    child.on("error", (error: Error): void => {
      reject(error);
    });

    child.on("close", (code: number | null): void => {
      const rawStdout = Buffer.concat(stdout).toString("utf8").trim();
      const rawStderr = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(rawStderr || rawStdout || `Windows agent exited with code ${code ?? "unknown"}`));
        return;
      }

      try {
        const result = JSON.parse(rawStdout) as AgentResult<T>;
        if (!result.ok) {
          reject(new Error(result.error || "Windows agent failed."));
          return;
        }
        resolve(result.value as T);
      } catch (error) {
        reject(new Error(`Windows agent returned invalid JSON: ${rawStdout || rawStderr || String(error)}`));
      }
    });
  });
};

export const listDisplaysViaAgent = async (): Promise<readonly DisplayInfo[]> =>
  await runAgent<DisplayInfo[]>("displays");

export const listWindowsViaAgent = async (includeAll: boolean): Promise<readonly WindowInfo[]> =>
  await runAgent<WindowInfo[]>("windows", { includeAll });

export const listMsfsProcessesViaAgent = async (): Promise<readonly ProcessInfo[]> =>
  await runAgent<ProcessInfo[]>("msfs-processes");

export const getSimStateViaAgent = async (): Promise<SimState> =>
  await runAgent<SimState>("sim-state");

export const moveWindowViaAgent = async (request: MoveWindowRequest): Promise<void> => {
  await runAgent<{ readonly ok: true }>("move-window", request as unknown as Record<string, unknown>);
};

export const setWindowTitleViaAgent = async (handle: string, title: string): Promise<void> => {
  await runAgent<{ readonly ok: true }>("set-title", { handle, title });
};

export const captureClickViaAgent = async (timeoutMs: number): Promise<CapturedClick> =>
  await runAgent<CapturedClick>("capture-click", { timeoutMs });

export const getCursorPositionViaAgent = async (): Promise<CapturedClick> =>
  await runAgent<CapturedClick>("cursor-position");

export const popOutClickViaAgent = async (input: {
  readonly x: number;
  readonly y: number;
  readonly clickMethod: "altGrClick" | "ctrlClick";
}): Promise<void> => {
  await runAgent<{ readonly ok: true }>("popout-click", input);
};

export const restoreCameraViaAgent = async (input: {
  readonly cameraState?: number;
  readonly cameraViewTypeAndIndex0?: number;
  readonly cameraViewTypeAndIndex1?: number;
}): Promise<void> => {
  await runAgent<{ readonly ok: true }>("restore-camera", input);
};
