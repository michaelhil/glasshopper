import { spawn } from "node:child_process";

export interface PowerShellResult {
  readonly stdout: string;
  readonly stderr: string;
}

export const runPowerShell = async (script: string): Promise<PowerShellResult> => {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ];

  return await new Promise<PowerShellResult>((resolve, reject): void => {
    const child = spawn(executable, args, {
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
      const result: PowerShellResult = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      };

      if (code === 0) {
        resolve(result);
        return;
      }

      reject(new Error(result.stderr || `PowerShell exited with code ${code ?? "unknown"}`));
    });
  });
};

export const parsePowerShellJson = <T>(stdout: string): T => {
  if (!stdout) {
    throw new Error("PowerShell returned no JSON output.");
  }

  return JSON.parse(stdout) as T;
};
