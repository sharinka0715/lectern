import type { NativePermissionScreen } from '../shared/native-permission';
import { parsePermissionBottom, parsePermissionScreen } from './permission-screen';

/** A tool call as the PermissionRequest hook handed it over. */
export interface PermissionCall { toolName: string; input: Record<string, unknown> }

/** The card shows at most this much of one text field, and the snapshot is sent with every poll. */
const FIELD_LIMIT = 20_000;
function trimmed(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > FIELD_LIMIT ? value.slice(0, FIELD_LIMIT) + '\n…' : value;
  if (depth > 4) return Array.isArray(value) ? [] : value && typeof value === 'object' ? {} : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => trimmed(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, trimmed(item, depth + 1)]));
  return value;
}
/** The call as the card shows it: long text cut (the whole input stays with Claude Code). */
export const displayCall = (call: PermissionCall): PermissionCall => ({ toolName: call.toolName, input: trimmed(call.input) as Record<string, unknown> });

const squash = (value: string) => value.replace(/\s+/gu, ' ').trim();
/** Whether the dialog's own text names this call: a file's name, or the start of a command, URL or
 * other text argument shows in its title, description or box. A request of another call (one
 * Claude Code asks about without a hook, e.g. after "Auto mode can't check actions") does not. */
export function screenShowsCall(screen: NativePermissionScreen, call: PermissionCall): boolean {
  const shown = squash([screen.title, ...screen.subtitle, ...screen.content].join(' '));
  const hints = Object.entries(call.input).flatMap(([key, value]) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    if (/path$/u.test(key)) return [value.split('/').filter(Boolean).at(-1) ?? value];
    return [squash(value.split('\n').find(line => line.trim()) ?? '').slice(0, 24)];
  }).filter(hint => hint.length >= 3);
  return hints.some(hint => shown.includes(hint));
}

/**
 * A tool's permission dialog read with its call from the PermissionRequest hook: the whole dialog
 * when the screen reads it and names the call; by its bottom rows alone (question, choices,
 * footer) when its top is out of the pane, titled with the tool's name. Never a keyed or other
 * native dialog (those have no PermissionRequest). The card and the driver read every frame so.
 */
export function readHookPermission(viewport: string, call: PermissionCall): NativePermissionScreen | undefined {
  const whole = parsePermissionScreen(viewport);
  if (whole) return !whole.kind && screenShowsCall(whole, call) ? { ...whole, call: displayCall(call) } : undefined;
  const bottom = parsePermissionBottom(viewport);
  return bottom && { title: call.toolName, subtitle: [], content: [], ...bottom, call: displayCall(call) };
}
