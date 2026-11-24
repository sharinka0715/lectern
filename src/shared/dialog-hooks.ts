/** One call of Lectern's recording hooks (backend/dialog-hooks.ts), checked: the event, the
 * session it is for, and for tool events the tool and its whole input. */
export interface DialogHookRecord {
  event: 'PreToolUse' | 'PermissionRequest' | 'SessionStart';
  /** Order of arrival in this launch: files are read oldest first. */
  seq: number;
  /** Seconds since the epoch when the hook ran (its file name). */
  at: number;
  toolName?: string;
  input?: Record<string, unknown>;
  /** PreToolUse only: PermissionRequest carries no tool_use_id. */
  toolUseId?: string;
  /** A subagent's call (agent_id): never what the main conversation's cards answer. */
  agentId?: string;
  /** SessionStart: startup, resume, clear or compact. */
  source?: string;
}

/** What the hooks of the session's current launch have delivered. Undefined in a read when
 * this launch has no hooks (the setting was off when it started, or not Lectern's launch). */
export interface DialogHookObservation {
  /** The launch's hook folder is still there. */
  folder: boolean;
  /** SessionStart seen: the hooks run in this process (not turned off by disableAllHooks,
   * managed allowManagedHooksOnly, or an untrusted folder). Hook data is used only then. */
  started?: { at: number; source?: string };
  /** The newest records, oldest first. */
  records: DialogHookRecord[];
  /** The newest record of any kind. */
  last?: { event: DialogHookRecord['event']; toolName?: string; at: number };
  /** Files that were not valid hook JSON for this session. */
  rejected: number;
}

/** The hooks' state for the open conversation, as the settings page and diagnostics show it. */
export type DialogHookStatus =
  | { state: 'off' }
  | { state: 'active'; since: number; last?: DialogHookObservation['last'] }
  | { state: 'waiting' }
  | { state: 'unavailable'; reason: 'no-folder' | 'not-launched' };
