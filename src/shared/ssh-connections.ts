/**
 * "设置 → SSH 连接 → 复用已有的 SSH 连接". On (the default): a machine whose ssh_config
 * already runs a ControlMaster is reached over that master, shared with the user's
 * terminals and editors, and Lectern keeps to fewer sessions there. Off: Lectern
 * uses only connections of its own (see Transport.setReuseUserMasters).
 */
export interface SshConnectionPreferences { reuseConnections: boolean }
export const defaultSshConnectionPreferences: SshConnectionPreferences = { reuseConnections: true };
