import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentExecuteResult, PluginEnvironmentRunnerRecoveryExecuteParams } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { handleDaytonaRunnerRecoveryExecute } from "./runner-recovery-execute.js";

function fixture() {
  const input: PluginEnvironmentRunnerRecoveryExecuteParams = { companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(),
    driverKey: "daytona", config: {}, workspaceRoot: "/workspace/app", execution: { command: "tar", args: ["-czf", "-", "."], timeoutMs: 120_000 },
    workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) },
    owner: { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" } };
  const sandbox = { id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId },
    refreshData: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), delete: vi.fn(),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: JSON.stringify({ state: "running" }) })) } };
  const result: PluginEnvironmentExecuteResult = { exitCode: 0, timedOut: false, stdout: "checkpoint", stderr: "" };
  const execute = vi.fn(async () => result);
  const run = () => handleDaytonaRunnerRecoveryExecute(sandbox as unknown as Sandbox, input, execute);
  return { input, sandbox, result, execute, run };
}
describe("original allocation recovery commands", () => {
  it.each(["running", "exited"])("permits checkpoint work with a verified %s root on already-started compute", async state => {
    const f = fixture(); f.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: JSON.stringify({ state }) });
    expect(await f.run()).toEqual({ state: "executed", workspaceConnection: f.input.workspaceConnection, result: f.result });
    expect(f.execute).toHaveBeenCalledWith({ ...f.input.execution, cwd: f.input.workspaceRoot });
    expect(f.sandbox.refreshData).toHaveBeenCalledTimes(2);
    for (const mutation of [f.sandbox.start, f.sandbox.stop, f.sandbox.delete]) expect(mutation).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived", "starting", "stopping", "error"])("does not execute or wake %s compute", async state => {
    const f = fixture(); f.sandbox.state = state;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.execute).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
    expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it.each(["mismatch", "unverified"])("refuses commands for %s process evidence", async state => {
    const f = fixture(); f.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: JSON.stringify({ state }) });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["cwd", "root", "nul", "timeout", "negative_timeout", "infinite_timeout"])("refuses invalid %s before contacting compute", async cause => {
    const f = fixture();
    if (cause === "cwd") f.input.execution.cwd = "/workspace/other";
    if (cause === "root") f.input.workspaceRoot = "/";
    if (cause === "nul") f.input.execution.args = ["bad\0argument"];
    if (cause === "timeout") f.input.execution.timeoutMs = 120_001;
    if (cause === "negative_timeout") f.input.execution.timeoutMs = -1;
    if (cause === "infinite_timeout") f.input.execution.timeoutMs = Infinity;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.refreshData).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["stopped", "ownership", "timeout", "no_exit"])("withholds results after %s uncertainty", async cause => {
    const f = fixture(); f.execute.mockImplementation(async () => {
      if (cause === "stopped") f.sandbox.state = "stopped";
      if (cause === "ownership") f.sandbox.labels["paperclip-company-id"] = randomUUID();
      return { ...f.result, timedOut: cause === "timeout", exitCode: cause === "no_exit" ? null : 0 };
    });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it("preserves an ordinary command failure without reporting successful checkpoint work", async () => {
    const f = fixture(); f.result.exitCode = 2; f.result.stderr = "missing directory";
    expect(await f.run()).toMatchObject({ state: "executed", result: { exitCode: 2, stderr: "missing directory" } });
  });
});
