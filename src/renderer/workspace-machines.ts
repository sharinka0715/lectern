import type { Workspace } from "../shared/types";
import type { ConnectionProfile } from "./desktop-state";
import { sshOnly } from "../shared/supported-targets";
import { t } from '../shared/i18n';

type Endpoint = Pick<Workspace, "kind" | "host" | "port">;
export interface WorkspaceMachine {
  key: string;
  name: string;
  endpoint: Endpoint;
  folders: Workspace[];
}

export function machineKey(endpoint: Endpoint) {
  if (endpoint.kind === "ssh") return JSON.stringify(["ssh", endpoint.host, endpoint.port ?? null]);
  return "local";
}

export function workspaceMachines(platform: string, profiles: ConnectionProfile[], workspaces: Workspace[]) {
  const machines = new Map<string, WorkspaceMachine>();
  function include(endpoint: Endpoint, name: string) {
    const key = machineKey(endpoint);
    let machine = machines.get(key);
    if (!machine) {
      machine = { key, name, endpoint, folders: [] };
      machines.set(key, machine);
    }
    return machine;
  }
  // Windows reaches SSH machines only: no local machine.
  if (!sshOnly(platform)) include({ kind: "local" }, t('workbench.local'));
  for (const profile of profiles) {
    include({ kind: "ssh", host: profile.host, port: profile.port }, profile.name || profile.host);
  }
  for (const workspace of workspaces) {
    const { kind, host, port } = workspace;
    include({ kind, host, port }, kind === "ssh" ? `${host}${port ? `:${port}` : ""}` : t('workbench.local')).folders.push(workspace);
  }
  return [...machines.values()];
}

/** The machine's name as the sidebar shows it: a saved connection's name, else host[:port]; t('workbench.local') for this computer. */
export function machineName(workspace: Endpoint, _platform: string, profiles: ConnectionProfile[]) {
  if (workspace.kind !== "ssh") return t('workbench.local');
  const key = machineKey(workspace), profile = profiles.find(row => machineKey({ kind: "ssh", host: row.host, port: row.port }) === key);
  return profile ? profile.name || profile.host : `${workspace.host}${workspace.port ? `:${workspace.port}` : ""}`;
}
