import { useSyncExternalStore } from "react";
import type { SshLoginTarget, Workspace } from "../shared/types";
import type { SshMasterState } from "../shared/ssh-connections";
import type { ConnectionProfile } from "./desktop-state";
import { needsSshLogin, openSshLogin } from "./ssh-login";
import { isUnsupportedTarget } from "../shared/supported-targets";
import { confirmAction, showToast } from "./ContextMenu";
import { t } from "../shared/i18n";

export interface SshMachine {
  /** Same key as the sidebar's machine group (workspace-machines.ts). */
  key: string;
  name: string;
  host: string;
  port?: number;
  /** The saved connection, when there is one. */
  profile?: ConnectionProfile;
  /** Project folders on this machine. A machine can be listed only because of them. */
  folders: number;
}

export const sshMachineKey = (host: string, port?: number) => JSON.stringify(["ssh", host, port ?? null]);

/** Every SSH machine Lectern knows: saved connections first, then machines that
 * only appear through their project folders, so lists match the sidebar. */
export function sshMachines(connections: ConnectionProfile[], workspaces: Workspace[]): SshMachine[] {
  const machines = new Map<string, SshMachine>();
  for (const profile of connections) {
    const key = sshMachineKey(profile.host, profile.port);
    if (!machines.has(key)) machines.set(key, { key, name: profile.name || profile.host, host: profile.host, port: profile.port, profile, folders: 0 });
  }
  for (const workspace of workspaces) {
    if (workspace.kind !== "ssh" || !workspace.host) continue;
    const key = sshMachineKey(workspace.host, workspace.port);
    let machine = machines.get(key);
    if (!machine) machines.set(key, machine = { key, name: `${workspace.host}${workspace.port ? `:${workspace.port}` : ""}`, host: workspace.host, port: workspace.port, folders: 0 });
    machine.folders++;
  }
  return [...machines.values()];
}

/** SSH errors that mean the machine cannot be reached or used right now. */
const unreachable = /ssh: |Could not resolve hostname|Connection (?:timed out|refused|reset)|Operation timed out|No route to host|Network is unreachable|kex_exchange_identification|banner exchange|Connection closed|ProxyCommand|channel \d+: open failed/i;
export function sshConnectionError(message: string | undefined) {
  return !!message && (needsSshLogin(message) || unreachable.test(message) || isUnsupportedTarget(message));
}
/** What a failure says about the machine: not logged in, unreachable, or not macOS/Linux at all. */
export function machineProblem(message: string): "login" | "unreachable" | "unsupported" {
  return isUnsupportedTarget(message) ? "unsupported" : needsSshLogin(message) ? "login" : "unreachable";
}

export type MachineConnection = { state: "checking" | "ok" | "disconnected" } | { state: "login" | "unreachable" | "unsupported"; message: string };

// One status per SSH machine for the whole window: the startup check, folder
// discovery and logins all report here; the sidebar and prompts read it.
const statuses = new Map<string, MachineConnection>();
const listeners = new Set<() => void>();
let version = 0;
function changed() { version++; listeners.forEach(listener => listener()); }

export function machineConnection(key: string): MachineConnection | undefined { return statuses.get(key); }
export function machineDisconnected(target?: { host?: string; port?: number }): boolean {
  return !!target?.host && machineConnection(sshMachineKey(target.host, target.port))?.state === "disconnected";
}
export function setMachineConnection(key: string, status: MachineConnection) {
  const previous = statuses.get(key);
  if (previous?.state === status.state && ("message" in status ? status.message : "") === (previous && "message" in previous ? previous.message : "")) return;
  statuses.set(key, status);
  changed();
}
/** A result for a command on this machine: success clears an earlier failure. */
export function reportMachineResult(host: string, port: number | undefined, error?: unknown) {
  const key = sshMachineKey(host, port);
  if (machineDisconnected({ host, port })) return;
  if (error === undefined) { setMachineConnection(key, { state: "ok" }); return; }
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  // Other failures (a missing folder, a busy pane) say nothing about the connection.
  if (!sshConnectionError(message)) return;
  setMachineConnection(key, { state: machineProblem(message), message });
}
export function useMachineConnections() {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version);
  return machineConnection;
}

/** Check each machine once with the everyday, non-interactive connection. Never
 * prompts. Machines with a known status are skipped unless `force` (a retry). */
export async function checkSshMachines(machines: SshMachine[], { concurrency = 3, force = false } = {}) {
  const queue = machines.filter(machine => !machineDisconnected(machine) && (force || !statuses.has(machine.key)));
  for (const machine of queue) setMachineConnection(machine.key, { state: "checking" });
  async function worker() {
    for (let machine = queue.shift(); machine; machine = queue.shift()) {
      try {
        const result = await window.desktop.checkSshConnection({ host: machine.host, ...(machine.port ? { port: machine.port } : {}) });
        if (machineDisconnected(machine)) continue;
        if (!result.ok && result.disconnected) setMachineConnection(machine.key, { state: "disconnected" });
        else if (result.ok) setMachineConnection(machine.key, { state: "ok" });
        else setMachineConnection(machine.key, { state: machineProblem(result.message), message: result.message });
      } catch (error) {
        if (!machineDisconnected(machine)) setMachineConnection(machine.key, { state: "unreachable", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

export function sshDisconnectHint(state: SshMasterState) {
  return state === "user" ? t('prefs.sshDisconnectUser') : state === "none" ? t('prefs.sshDisconnectNone') : undefined;
}

export async function disconnectSshMachine(target: SshLoginTarget, name: string) {
  let result = await window.desktop.disconnectSsh(target);
  if (typeof result === "object") {
    const { terminal, input } = result;
    if (!await confirmAction({ title: t('prefs.sshDisconnectTitle', { name }), danger: true, confirmLabel: t('prefs.sshDisconnect'),
      message: t(terminal && input ? 'prefs.sshDisconnectBoth' : terminal ? 'prefs.sshDisconnectTerminal' : 'prefs.sshDisconnectInput'),
      detail: t('prefs.sshDisconnectRemote') })) return;
    result = await window.desktop.disconnectSsh(target, true);
  }
  if (result === "disconnected") setMachineConnection(sshMachineKey(target.host, target.port), { state: "disconnected" });
}

const connecting = new Map<string, Promise<boolean>>();
/** Explicit reconnects from either split and both machine lists share one authentication attempt. */
export function connectSshMachine(target: SshLoginTarget, label?: string): Promise<boolean> {
  const key = sshMachineKey(target.host, target.port), current = connecting.get(key);
  if (current) return current;
  const request = (async () => {
    try {
      const result = await window.desktop.connectSsh(target);
      if (!result.ok) {
        if (!needsSshLogin(result.message)) { showToast(result.message); return false; }
        const signedIn = await new Promise<boolean>(resolve => openSshLogin(target, {
          label, onDone: () => resolve(true), onClose: () => resolve(false),
        }));
        if (!signedIn) return false;
      }
      setMachineConnection(key, { state: "ok" });
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      return false;
    }
  })();
  connecting.set(key, request);
  void request.finally(() => connecting.delete(key));
  return request;
}

// Connection problems stay quiet at startup; the top prompt appears once the
// user navigates (a machine, folder or conversation in the sidebar).
let navigated = false;
const navigationListeners = new Set<() => void>();
export function markNavigated() {
  if (navigated) return;
  navigated = true;
  navigationListeners.forEach(listener => listener());
}
export function useNavigated() {
  return useSyncExternalStore(listener => { navigationListeners.add(listener); return () => { navigationListeners.delete(listener); }; }, () => navigated);
}
