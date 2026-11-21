import { importableSshAlias, type SshConfigHost } from "../shared/ssh-config";
import type { ConnectionProfile } from "./desktop-state";

export type SshImportStatus = "available" | "saved" | "unsupported";
export interface SshImportRow { host: SshConfigHost; status: SshImportStatus }

/** A machine is identified by host and port; an alias imported without a port
 * is the same machine as one typed by hand with that alias and no port. */
export function sshImportRows(hosts: SshConfigHost[], connections: ConnectionProfile[]): SshImportRow[] {
  const saved = new Set(connections.filter(c => c.port === undefined).map(c => c.host));
  return hosts.map(host => ({
    host,
    status: !importableSshAlias(host.alias) ? "unsupported" : saved.has(host.alias) ? "saved" : "available",
  }));
}

export function filterSshImportRows(rows: SshImportRow[], query: string): SshImportRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(({ host }) => [host.alias, host.hostName, host.user, host.proxyJump]
    .some(value => value?.toLowerCase().includes(needle)));
}

/** New profiles keep the alias as both name and host, so OpenSSH resolves the rest. */
export function importSshConnections(chosen: Iterable<string>, rows: SshImportRow[], connections: ConnectionProfile[],
  newId: () => string = () => crypto.randomUUID()): ConnectionProfile[] {
  const wanted = new Set(chosen), next = [...connections];
  for (const { host, status } of rows) {
    if (status !== "available" || !wanted.has(host.alias)) continue;
    if (next.some(c => c.host === host.alias && c.port === undefined)) continue;
    next.push({ id: newId(), name: host.alias, host: host.alias });
  }
  return next;
}
