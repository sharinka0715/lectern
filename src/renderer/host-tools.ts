import { useSyncExternalStore } from "react";
import { isMissingToolsError, missingTools, type HostTool, type HostTools } from "../shared/host-tools";
import type { WorkspaceEndpoint } from "../shared/types";
import { machineKey } from "./workspace-machines";
import { reportMachineResult } from "./ssh-machines";

/** What the window knows about a machine's tmux and Claude Code. `checking` keeps the
 * previous result, so a notice stays up (with a spinner) while it is rechecked. */
export type HostToolsStatus =
  | { state: "checking"; tools?: HostTools }
  | { state: "ok" | "missing"; tools: HostTools }
  | { state: "failed"; message: string };

// One status per machine for the whole window (both split views read it).
const statuses = new Map<string, HostToolsStatus>();
const running = new Map<string, { request: Promise<HostToolsStatus> }>();
const listeners = new Set<() => void>();
let version = 0;
function set(key: string, status: HostToolsStatus) {
  statuses.set(key, status);
  version++;
  listeners.forEach(listener => listener());
}

export const hostToolsStatus = (endpoint: WorkspaceEndpoint) => statuses.get(machineKey(endpoint));
/** The tools a machine lacks, also while it is being rechecked. */
export function hostMissing(status: HostToolsStatus | undefined): HostTool[] {
  return status && "tools" in status && status.tools ? missingTools(status.tools) : [];
}
export function useHostTools() {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version);
  return hostToolsStatus;
}

/** Ask the main process (one probe per machine, kept there until `force`). A check that
 * could not run is `failed` and, for SSH, reported as that machine's connection result. */
export function checkHostTools(endpoint: WorkspaceEndpoint, { force = false } = {}): Promise<HostToolsStatus> {
  const key = machineKey(endpoint), pending = running.get(key);
  if (pending && !force) return pending.request;
  const previous = statuses.get(key);
  set(key, { state: "checking", tools: previous && "tools" in previous ? previous.tools : undefined });
  const target = { kind: endpoint.kind, ...(endpoint.kind === "ssh" && { host: endpoint.host, ...(endpoint.port && { port: endpoint.port }) }) };
  const turn = {} as { request: Promise<HostToolsStatus> };
  running.set(key, turn);
  turn.request = (async () => {
    let result: HostToolsStatus;
    try {
      const check = await window.desktop.checkHost(target, force);
      result = check.ok ? { state: missingTools(check.tools).length ? "missing" : "ok", tools: check.tools } : { state: "failed", message: check.message };
      if (endpoint.kind === "ssh" && endpoint.host) reportMachineResult(endpoint.host, endpoint.port, check.ok ? undefined : new Error(check.message));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { state: "failed", message: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") };
    }
    // A forced recheck started meanwhile has the last word.
    if (running.get(key) === turn) { running.delete(key); set(key, result); }
    return result;
  })();
  return turn.request;
}

/** Going to a machine: check it unless known; one missing a tool is checked again, as the
 * user may have installed it meanwhile. */
export function ensureHostTools(endpoint: WorkspaceEndpoint) {
  const status = hostToolsStatus(endpoint);
  if (!status || status.state === "failed") void checkHostTools(endpoint);
  else if (status.state === "missing") void checkHostTools(endpoint, { force: true });
}
/** A folder on this machine was read (or failed to): the first success, or a refusal for a
 * missing tool, fetches the machine's result (the main process already has it). */
export function noteFolderRead(endpoint: WorkspaceEndpoint, error?: unknown) {
  const status = hostToolsStatus(endpoint);
  if (error === undefined ? !status || status.state === "failed"
    : isMissingToolsError(error instanceof Error ? error.message : String(error)) && status?.state !== "missing" && status?.state !== "checking")
    void checkHostTools(endpoint);
}
