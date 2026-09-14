import { posix } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentExecuteResult, PluginEnvironmentRunnerRecoveryExecuteParams, PluginEnvironmentRunnerRecoveryExecuteResult } from "@paperclipai/plugin-sdk";
import { handleDaytonaRunProcessControl } from "./run-process-control.js";

export const MAX_RUNNER_RECOVERY_COMMAND_MS = 120_000;

/** One-shot host work in the original, already-started allocation. The caller
 * verifies the saved connection before lookup and supplies a profile-free
 * executor. An exited original root permits checkpoint reads, not replacement. */
export async function handleDaytonaRunnerRecoveryExecute(
  sandbox: Sandbox,
  params: PluginEnvironmentRunnerRecoveryExecuteParams,
  execute: (execution: PluginEnvironmentRunnerRecoveryExecuteParams["execution"]) => Promise<PluginEnvironmentExecuteResult>,
): Promise<PluginEnvironmentRunnerRecoveryExecuteResult> {
  const unavailable = { state: "unverified" } as const;
  const root = params.workspaceRoot;
  const command = params.execution;
  const cwd = command?.cwd ?? root;
  if (typeof root !== "string" || root === "/" || root.length > 4096 || root.includes("\0") || posix.resolve(root) !== root
    || typeof cwd !== "string" || cwd.includes("\0") || posix.resolve(cwd) !== cwd || (cwd !== root && !cwd.startsWith(`${root}/`))
    || !command || typeof command.command !== "string" || !command.command || command.command.includes("\0")
    || (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))))
    || (command.stdin !== undefined && typeof command.stdin !== "string")
    || (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0 || command.timeoutMs > MAX_RUNNER_RECOVERY_COMMAND_MS))) return unavailable;
  const inspect = () => handleDaytonaRunProcessControl(sandbox, { ...params, operation: { action: "inspect" } });
  const before = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(before.state)) return unavailable;
  const result = await execute({ ...command, cwd, timeoutMs: command.timeoutMs ?? 30_000 });
  if (result.timedOut || result.exitCode === null || !Number.isInteger(result.exitCode)
    || typeof result.stdout !== "string" || typeof result.stderr !== "string") return unavailable;
  const after = await inspect();
  if (sandbox.state !== "started" || !["running", "exited"].includes(after.state)) return unavailable;
  return { state: "executed", workspaceConnection: params.workspaceConnection, result };
}
