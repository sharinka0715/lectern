/**
 * "设置 → SSH 连接 → 复用已有的 SSH 连接". On (the default): a machine whose ssh_config
 * already runs a ControlMaster is reached over that master, shared with the user's
 * terminals and editors, and Lectern keeps to fewer sessions there. Off: Lectern
 * uses only connections of its own (see Transport.setReuseUserMasters).
 */
export const sshKeepAliveChoices = [0, 900, 3600, 14400, 28800, 86400] as const;
export type SshKeepAliveSeconds = typeof sshKeepAliveChoices[number];
export interface SshConnectionPreferences { reuseConnections: boolean; keepAliveSeconds: SshKeepAliveSeconds }
export const defaultSshConnectionPreferences: SshConnectionPreferences = { reuseConnections: true, keepAliveSeconds: 3600 };

export type SshMasterState = 'private' | 'user' | 'none' | 'disconnected';
export type SshDisconnectResult = SshMasterState | { terminal: boolean; input: boolean };
