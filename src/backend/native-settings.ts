import { randomUUID } from 'node:crypto';
import { diagnostic, errorDetails, summarize } from '../diagnostics';
import { focusedSettingCommandHistory, isIdleEmptyComposer, newSettingViewport, priorComposerHistory, readSettingReceipt, parseSettingScreen } from '../core/settings-screen';
import type { SessionSettingKind, SessionSettingOption, SessionSettingSnapshot } from '../shared/types';
import { sessionSettingTicketLifetimeMs } from '../shared/session-setting-ticket';
import { stripTerminalEscapes } from '../core/screen';
import { t } from '../shared/i18n';

type Parsed = ReturnType<typeof parseSettingScreen>;
type Menu = Extract<Parsed, { state: 'menu' }>;
type MenuOption = Menu['options'][number];
type PageKey = 'Home' | 'End' | 'PageUp' | 'PageDown';
export interface SettingDriver {
  /** Checked drivers compare their last viewport on the target immediately before every input. */
  readonly guardsViewport?: boolean;
  inspect(settle?: boolean): Promise<{ paneId: string; viewport: string; stable?: boolean }>;
  type(command: string, paneId: string): Promise<void>;
  /** Submit an existing verified draft, guarding the exact inspected frame. */
  submitPending?(command: '/model' | '/effort', paneId: string): Promise<void>;
  permitsPageKey?(key: PageKey): Promise<boolean>;
  key(key: 'Up' | 'Down' | 'Left' | 'Right' | 'Escape' | 'Enter' | 's' | PageKey, paneId: string, confirmation?: boolean): Promise<void>;
}
export interface SettingContext { workspaceId: string; sessionId: string; targetKey: string }
export interface SettingReadOptions { resumePendingCommand?: boolean }
interface Catalog { kind: SessionSettingKind; paneId: string; command: string; options: MenuOption[]; currentKey?: string; complete: boolean; detail?: string; nativeFeedback?: string; menu: Menu }
type Choice = Pick<SessionSettingOption, 'label' | 'description'> & {
  /** What `/model` or `/effort` takes for this row, from Claude Code's SDK model list. */
  value?: string;
};
/** Model and effort rows from the machine's model list, before a session binds them. */
export interface SettingChoices { kind: SessionSettingKind; command: string; complete: boolean; detail?: string; options: (Choice & { disabled?: boolean })[] }
interface Ticket {
  context: SettingContext;
  paneId: string;
  kind: SessionSettingKind;
  complete: boolean;
  choices: Map<string, Choice>;
  expires: number;
  /** Present only when this very pane supplied the original menu. */
  baseline?: { state: string; currentKey?: string };
  /** Every native choice in order, to report the result of an inline switch. */
  menu: (Choice & { disabled?: boolean })[];
  command: string;
}
interface Transaction { driver: SettingDriver; context: SettingContext; kind: SessionSettingKind; paneId: string; deadline: number; inlineCommand?: string; pageKeysIgnored?: boolean; preserveFrame?: boolean; initialViewport?: string; pendingCommandHistory?: string[]; lastMenu?: Menu; menuViewport?: string; history?: string[]; captureHash?: string; captureId?: string }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const menuState = (menu: Menu) => JSON.stringify({ options: menu.options.map(o => [o.key, o.ordinal, o.description, o.disabled, o.disclosure, o.current, o.focused]), focused: menu.focusedKey, current: menu.currentKey, before: menu.hasMoreBefore, after: menu.hasMoreAfter, beforeCount: menu.moreBeforeCount, afterCount: menu.moreAfterCount, sessionOnlyKey: menu.sessionOnlyKey, cancelKey: menu.cancelKey, disclosureAction: menu.disclosureAction });
const catalogState = (catalog: Catalog) => JSON.stringify(catalog.options.map(o => [o.ordinal, o.key, o.label, o.description, o.disabled, o.disclosure]));
const sameChoice = (left: Choice, right: Choice) => left.label === right.label && left.description === right.description;

/** The native counts include visible disclosure rows even when they do not
 * consume a model ordinal. A page key moves the physical cursor position. */
function pageRange(menu: Menu) {
  if (menu.kind !== 'model' || !menu.cancelKey) return;
  const before = menu.hasMoreBefore ? menu.moreBeforeCount : 0;
  const after = menu.hasMoreAfter ? menu.moreAfterCount : 0;
  if (before === undefined || after === undefined || (menu.hasMoreBefore && before < 1) || (menu.hasMoreAfter && after < 1)) return;
  const first = before + 1, last = before + menu.options.length, total = last + after;
  const index = menu.options.findIndex(row => row.focused);
  if (index < 0 || total > 64) return;
  return { first, last, total, focus: first + index, width: menu.options.length };
}
function numberedPage(menu: Menu) {
  const page = pageRange(menu);
  if (page && menu.options.every((row, i) => !row.disclosure && row.ordinal === page.first + i)) return page;
}

/** A configured custom model (ANTHROPIC_CUSTOM_MODEL_OPTION) without its own
 * description shows its ID as "Custom model (<id>)". */
const customModelId = (description?: string) => /^Custom model \(([A-Za-z0-9][A-Za-z0-9._:\/@\[\]+-]{0,127})\)$/u.exec(description ?? '')?.[1];

function confirmationTargetEvidence(option: MenuOption, target: string): 'label' | 'description-first-segment' | 'default-description' | 'custom-model-id' | undefined {
  if (target === option.label) return 'label';
  if (customModelId(option.description) === target) return 'custom-model-id';
  // Native short labels such as "Sonnet" may have an explicit full display
  // name before the description's middle-dot separator. Match that entire
  // observed name only; never infer a version or match a family/substring.
  const segments = option.description?.split(/\s+[·•]\s+/u);
  if (segments && segments.length > 1 && segments[0].trim() === target) return 'description-first-segment';
  const defaultName = /^Use the default model \(currently (.+)\)$/u.exec(segments?.[0] ?? '')?.[1];
  if (option.label === 'Default (recommended)' && defaultName && target === defaultName + ' (default)') return 'default-description';
}

/** `/model <alias|configured custom ID>` and `/effort <level>`. Choices whose ID
 * the menu does not show keep the menu flow: an ID that is not one of the
 * configured models would make Claude send a validation request first. With
 * the SDK's value, only an alias, the default row (whose receipt names it) and
 * a configured custom model switch inline; other IDs (More models, gateway
 * models) keep the session-only menu. */
export function inlineSettingArgument(kind: SessionSettingKind, choice: Choice): string | undefined {
  const label = choice.label.trim();
  if (kind === 'effort') {
    const level = (choice.value ?? label).toLowerCase();
    return /^(?:low|medium|high|xhigh|max)$/.test(level) ? level : undefined;
  }
  if (choice.value !== undefined) {
    if (choice.value === 'default') return /^Use the default model\b/u.test(choice.description ?? '') ? 'default' : undefined;
    if (/^(?:opus|sonnet|haiku|fable)(?:\[1m\])?$/.test(choice.value)) return choice.value;
    return customModelId(choice.description) === choice.value ? choice.value : undefined;
  }
  if (/^Default\b/i.test(label) && /^Use the default model\b/u.test(choice.description ?? '')) return 'default';
  const family = /^(Opus|Sonnet|Haiku|Fable)( \(1M context\))?$/i.exec(label);
  if (family) return family[1].toLowerCase() + (family[2] ? '[1m]' : '');
  // A configured custom model switches by its ID without a validation request;
  // an ID that is not configured would make Claude query the model service.
  return customModelId(choice.description);
}

function verifyReceipt(kind: SessionSettingKind, option: MenuOption, message: string, inline = false): string | undefined {
  if (kind === 'model') {
    // The inline form saves the choice as the default for new sessions.
    // A gateway or custom ID is followed by a note on the assumed context window.
    const match = (inline ? /^(?:Set model to|Model set to) (.+?) (?:and saved as your default for new sessions|for this session only)(?:\s+(\S.*))?$/u
      : /^(?:Set model to|Model set to) (.+?) for this session only$/u).exec(message);
    if (match && confirmationTargetEvidence(option, match[1])) return match[2];
  } else {
    const scope = inline ? String.raw`\((?:this session only|saved as your default for new sessions|saved, though your organization starts new sessions on .+ at \S+ effort)\)` : String.raw`\(this session only\)`;
    const target = new RegExp(String.raw`^Set effort level to (.+?) ${scope}: \S`, 'u').exec(message)?.[1];
    if (target === option.label) return;
    const overridden = /^CLAUDE_CODE_EFFORT_LEVEL=\S+ overrides this session — clear it and (.+?) takes over$/u.exec(message)?.[1];
    if (overridden === option.label) return message;
    if (/^(?:Not applied: |Effort '.+' exceeds the cap for |Couldn't set effort level: )/u.test(message)) throw new SessionSettingError(message);
  }
  throw new SessionSettingError(t('native.receiptUnconfirmed'));
}

/** Claude 2.1.328: "Ultracode on (this session only): …" / "Ultracode off. Effort stays …". */
export function ultracodeReceipt(on: boolean, message: string): boolean {
  if (on ? /^Ultracode on \(this session only\): \S/u.test(message) : /^Ultracode off\. /u.test(message)) return on;
  if (/^Ultracode needs dynamic workflows turned on\b/u.test(message))
    throw new SessionSettingError(t('native.workflowsOff'));
  const model = /^Ultracode isn't available on (.+?)\. Options:/u.exec(message)?.[1];
  if (model) throw new SessionSettingError(t('native.modelNoUltracode', { model }));
  throw new SessionSettingError(t('native.ultracodeUnconfirmed', { message }));
}

export class SessionSettingError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionSettingError'; }
}

class PendingHookConfirmation extends SessionSettingError {}

/**
 * A guard refused before sending any key, so one retry is safe. Such messages
 * say 未发送按键 / "no keys were sent" in either language, including ones a
 * target script printed to stderr.
 */
export function keysNotSent(error: unknown): error is Error {
  return error instanceof Error && /未发送按键|no keys were sent/i.test(error.message);
}

/** The target explicitly returned a unique receipt before its send-keys command. */
export class NavigationKeyNotSent extends SessionSettingError {
  constructor(message = t('native.screenChangedNoKeys')) { super(message); }
}

/** The transcript changed since the decision was read (its revision guard runs before any
 * input): nothing was sent, and sending again under the same guard cannot succeed. */
export class TranscriptChangedNoKeys extends NavigationKeyNotSent {
  constructor() { super(t('native.recordChangedNoKeys')); }
}

// The focused xhigh and max labels repaint while their text and the slider
// pointer stay still. Only foreground colors, bold and their resets within
// the one parsed label may vary. Everything else remains in the frame hash.
const labelPaint = String.raw`\[(0|1|22|3[0-7]|39|49|9[0-7]|38;5;[0-9]+|38;2;[0-9]+;[0-9]+;[0-9]+)m`;
const labelPaintPattern = new RegExp('\x1b' + labelPaint, 'g');
export function effortFrameGuard(viewport: string, tailLines?: number) {
  const unchanged = { viewport, filter: '' };
  const menu = parseSettingScreen(viewport, 'effort');
  if (menu.state !== 'menu' || !menu.cancelKey || !menu.effortFocusCell) return unchanged;
  const label = menu.observedEffort?.value;
  const rows = viewport.split('\n');
  let footer = rows.length - 1;
  while (footer >= 0 && !stripTerminalEscapes(rows[footer]).trim()) footer--;
  const row = footer - menu.effortFocusCell.linesAboveFooter;
  const skipped = tailLines === undefined ? 0 : Math.max(0, rows.length - 1 - tailLines);
  if (!label || row < skipped || !rows[row]) return unchanged;
  for (const token of rows[row].matchAll(/[^ \t]+/g)) {
    if (token[0] === label || token[0].replace(labelPaintPattern, '') !== label) continue;
    const prefix = rows[row].slice(0, token.index);
    if (stripTerminalEscapes(prefix).length !== menu.effortFocusCell.column) continue;
    rows[row] = prefix + label + rows[row].slice(token.index! + token[0].length);
    // C locale makes substr use bytes, exactly as in the capture/hash. A
    // different row, pointer, text, spacing or styling outside this token
    // still changes the digest immediately before sending the key.
    const offset = Buffer.byteLength(prefix);
    const filter = ` | LC_ALL=C awk 'NR == ${row - skipped + 1} {
      suffix = substr($0, ${offset + 1})
      if (match(suffix, /^[^ \\t]+/)) {
        cell = substr(suffix, 1, RLENGTH); rest = substr(suffix, RLENGTH + 1)
        gsub(/\\033${labelPaint}/, "", cell)
        $0 = substr($0, 1, ${offset}) cell rest
      }
    } { print }'`;
    return { viewport: rows.join('\n'), filter };
  }
  return unchanged;
}

function navigationFrame(viewport: string, kind: SessionSettingKind) {
  const sgr = /\x1b\[[\d;:]*m/g;
  const lines = (kind === 'model' ? viewport.replace(sgr, '').replace(/[ \t]+$/gm, '') : effortFrameGuard(viewport).viewport).split('\n');
  const heading = kind === 'model' ? 'Select model' : 'Effort';
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].replace(sgr, '').trim() !== heading) continue;
    const ruler = lines[i - 1].replace(sgr, '').trimEnd();
    const match = /^([ \t]*)▔{5,}(?: tmux focus-events off · add 'set -g focus-events on' to ~\/\.tmux\.conf and reattach for focus tracking ▔+)?$/u.exec(ruler);
    if (match) lines[i - 1] = match[1] + '▔';
    break; // Earlier headings and rulers belong to the conversation history.
  }
  return lines.join('\n');
}

/** Every option comes from the live native menu. Tickets only reference observed
 * choices; renderer-supplied model names or shell fragments are never accepted. */
export class NativeSettings {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly timeoutMs = 30_000) {}

  private async observe(tx: Transaction, phase: string, settle = false): Promise<{ viewport: string; parsed: Parsed; stable?: boolean }> {
    if (Date.now() > tx.deadline) throw new SessionSettingError(t('native.menuReadTimeout'));
    const observation = await tx.driver.inspect(settle);
    if (observation.paneId !== tx.paneId) throw new SessionSettingError(t('native.paneBindingChanged'));
    const digest = summarize(observation.viewport);
    if (digest.sha256 !== tx.captureHash || !tx.captureId) {
      tx.captureId = diagnostic.capture('settings.viewport', observation.viewport, { kind: tx.kind, phase, paneId: tx.paneId, sessionId: tx.context.sessionId });
      tx.captureHash = digest.sha256;
    }
    let parsed = parseSettingScreen(observation.viewport, tx.kind);
    if (parsed.state === 'unrecognized' && tx.history?.length) {
      const changed = newSettingViewport(observation.viewport, tx.history);
      if (changed !== observation.viewport) parsed = parseSettingScreen(changed, tx.kind);
    }
    diagnostic.event('settings.observed', { kind: tx.kind, phase, paneId: tx.paneId, state: parsed.state, captureId: tx.captureId, viewport: digest });
    tx.lastMenu = parsed.state === 'menu' ? parsed : undefined;
    tx.menuViewport = tx.lastMenu ? observation.viewport : undefined;
    return { viewport: observation.viewport, parsed, stable: observation.stable };
  }
  private async transaction(driver: SettingDriver, context: SettingContext, kind: SessionSettingKind, options: SettingReadOptions = {}): Promise<Transaction> {
    if (kind !== 'model' && kind !== 'effort') throw new SessionSettingError(t('native.unsupportedMenu'));
    const first = await driver.inspect();
    const tx: Transaction = { driver, context, kind, paneId: first.paneId, deadline: Date.now() + this.timeoutMs, initialViewport: driver.guardsViewport ? first.viewport : undefined };
    diagnostic.capture('settings.viewport', first.viewport, { kind, phase: 'idle-guard', paneId: first.paneId, sessionId: context.sessionId });
    if (!isIdleEmptyComposer(first.viewport)) {
      if (options.resumePendingCommand && driver.guardsViewport && driver.submitPending) {
        tx.pendingCommandHistory = focusedSettingCommandHistory(first.viewport, kind === 'model' ? '/model' : '/effort');
      }
      if (!tx.pendingCommandHistory) throw new SessionSettingError(t('native.needIdleEmpty'));
    }
    return tx;
  }
  private async waitMenu(tx: Transaction, previousFocus?: string, expanded = false, previous = ''): Promise<Menu> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { parsed, stable } = await this.observe(tx, 'menu-settle', true);
      if (parsed.state === 'menu' && parsed.focusedKey && (!previousFocus || parsed.focusedKey !== previousFocus)
        && (!expanded || parsed.options.some(option => option.disclosure === 'expanded') || parsed.disclosureAction === 'collapse')) {
        const state = menuState(parsed);
        if (stable || state === previous) return parsed;
        previous = state;
      } else previous = '';
      await delay(60);
    }
    throw new SessionSettingError(t('native.menuUnstable'));
  }
  private async waitIdle(tx: Transaction): Promise<void> {
    let matched = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await this.observe(tx, 'idle-confirm', true);
      if (isIdleEmptyComposer(frame.viewport)) { if (frame.stable || matched) return; matched = true; } else matched = false;
      await delay(60);
    }
    throw new SessionSettingError(t('native.menuNotClosed'));
  }
  /** Cache acknowledgement is bound to the same kind and exact selected value. */
  private async waitApplied(tx: Transaction, requested: MenuOption): Promise<{ confirmed: boolean; feedback?: string }> {
    let idleFrames = 0, lastReceipt: string | undefined, previousConfirmation = '', movedFocus = false, confirmed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await this.observe(tx, 'apply-confirm');
      if (isIdleEmptyComposer(frame.viewport)) {
        const receipt = readSettingReceipt(frame.viewport, tx.kind, tx.history ?? [], tx.inlineCommand);
        if (receipt && receipt === lastReceipt) return { confirmed, feedback: verifyReceipt(tx.kind, requested, receipt, !!tx.inlineCommand) };
        lastReceipt = receipt;
        if (++idleFrames >= 8) throw new SessionSettingError(t('native.noReceipt'));
      } else {
        idleFrames = 0;
        lastReceipt = undefined;
        const confirmation = frame.parsed;
        if (confirmation.state === 'model-confirmation' || confirmation.state === 'effort-confirmation') {
          const targetEvidence = tx.kind === 'model' ? confirmationTargetEvidence(requested, confirmation.targetLabel)
            : requested.label === confirmation.targetLabel ? 'label' : undefined;
          if (tx.kind !== confirmation.kind || !targetEvidence) throw new SessionSettingError(t('native.confirmationMismatch', { kind: tx.kind }));
          const state = JSON.stringify(confirmation);
          if (!confirmed && state === previousConfirmation) {
            const fresh = (await this.observe(tx, 'before-cache-confirmation-key')).parsed;
            if (fresh.state !== confirmation.state || JSON.stringify(fresh) !== state) throw new SessionSettingError(t('native.cacheScreenChanged'));
            if (fresh.focused === 'cancel') {
              if (movedFocus) throw new SessionSettingError(t('native.cacheFocusUnsafe'));
              movedFocus = true;
              const key = fresh.confirmOrdinal < fresh.cancelOrdinal ? 'Up' : 'Down';
              diagnostic.event('settings.cache_confirmation.focus', { paneId: tx.paneId, targetLabel: fresh.targetLabel, optionLabel: requested.label, targetEvidence, footerObserved: fresh.footerObserved, key, captureId: tx.captureId });
              await tx.driver.key(key, tx.paneId, true);
            } else {
              // Set before dispatch: an uncertain command receipt must not be retried.
              confirmed = true;
              diagnostic.event('settings.cache_confirmation.accept', { paneId: tx.paneId, targetLabel: fresh.targetLabel, optionLabel: requested.label, targetEvidence, footerObserved: fresh.footerObserved, key: 'Enter', consequence: 'next_response_rereads_history', scope: 'session', captureId: tx.captureId });
              await tx.driver.key('Enter', tx.paneId, true);
            }
            previousConfirmation = '';
          } else previousConfirmation = state;
        } else {
          previousConfirmation = '';
          if (confirmation.state === 'unrecognized' && confirmation.reason === 'model-hook-confirmation') {
            throw new PendingHookConfirmation(t('native.hookWaiting'));
          }
        }
      }
      await delay(60);
    }
    throw new SessionSettingError(t('native.notBackToComposer'));
  }
  private async open(tx: Transaction): Promise<{ menu: Menu; command: string; detail?: string }> {
    const before = tx.initialViewport !== undefined ? { viewport: tx.initialViewport } : await this.observe(tx, 'before-open');
    tx.initialViewport = undefined;
    const command = tx.kind === 'model' ? '/model' : '/effort';
    if (tx.pendingCommandHistory && tx.driver.submitPending) {
      tx.history = tx.pendingCommandHistory;
      tx.pendingCommandHistory = undefined;
      diagnostic.event('settings.resume_pending_command', { kind: tx.kind, paneId: tx.paneId });
      await tx.driver.submitPending(command, tx.paneId);
    } else {
      if (!isIdleEmptyComposer(before.viewport)) throw new SessionSettingError(t('native.composerBusyNoCommand'));
      tx.history = priorComposerHistory(before.viewport);
      diagnostic.capture('settings.input', command, { kind: tx.kind, phase: 'open', paneId: tx.paneId });
      await tx.driver.type(command, tx.paneId);
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await this.observe(tx, 'opening', true);
      if (frame.parsed.state === 'menu') return { menu: frame.stable && frame.parsed.focusedKey ? frame.parsed : await this.waitMenu(tx, undefined, false, menuState(frame.parsed)), command };
      // A previous unsupported-command response may still be on screen while
      // the new command is rendering. Only a fresh matching failure is evidence.
      if (frame.parsed.state === 'unknown-command' && frame.parsed.command === command && frame.viewport !== before.viewport) {
        throw new SessionSettingError(t('native.noSettingCommand'));
      }
      await delay(60);
    }
    throw new SessionSettingError(t('native.menuUnrecognized'));
  }

  private async assertMenu(tx: Transaction, expected: Menu): Promise<Menu> {
    if (tx.driver.guardsViewport && tx.lastMenu === expected) return expected;
    const current = (await this.observe(tx, 'before-key')).parsed;
    if (current.state !== 'menu' || menuState(current) !== menuState(expected)) throw new SessionSettingError(t('native.menuChangedReread'));
    return current;
  }
  private async move(tx: Transaction, menu: Menu, key: 'Up' | 'Down' | 'Left' | 'Right'): Promise<Menu> {
    await this.assertMenu(tx, menu);
    diagnostic.event('settings.key', { kind: tx.kind, key, paneId: tx.paneId, previousFocus: menu.focusedKey });
    await this.navigationKey(tx, menu, key);
    return this.waitMenu(tx, menu.focusedKey);
  }
  private async navigationKey(tx: Transaction, menu: Menu, key: PageKey | 'Up' | 'Down' | 'Left' | 'Right' | 'Escape'): Promise<void> {
    const before = tx.menuViewport;
    try { return await tx.driver.key(key, tx.paneId); }
    catch (error) {
      if (!(error instanceof NavigationKeyNotSent) || !tx.driver.guardsViewport || before === undefined) {
        if (key === 'Escape') tx.preserveFrame = true;
        throw error;
      }
    }
    // A changed or ambiguous observation belongs to the user. Suppress even
    // cleanup Esc until a fresh, identical owned menu is proven again.
    tx.preserveFrame = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const frame = await this.observe(tx, 'navigation-guard-redraw', true);
      if (frame.parsed.state !== 'menu' || menuState(frame.parsed) !== menuState(menu)
        || navigationFrame(frame.viewport, tx.kind) !== navigationFrame(before, tx.kind)) {
        throw new SessionSettingError(t('native.menuChangedNoKeys'));
      }
      if (frame.stable || attempt === 1) break;
    }
    diagnostic.event('settings.navigation_redraw', { paneId: tx.paneId, key, previousReceipt: 'not_sent' });
    // The driver rechecks the new exact raw frame and the foreground process.
    // Keep cleanup disabled if this second receipt is lost or rejected.
    await tx.driver.key(key, tx.paneId);
    tx.preserveFrame = false;
  }
  private async scanStep(tx: Transaction, menu: Menu, direction: 'Up' | 'Down'): Promise<Menu> {
    const page = numberedPage(menu);
    if (!page || !menu.sessionOnlyKey || menu.options.some(row => row.disabled) || !tx.driver.permitsPageKey || tx.pageKeysIgnored) return this.move(tx, menu, direction);
    const up = direction === 'Up', hidden = up ? page.first - 1 : page.total - page.last;
    const edge = hidden <= page.width;
    const key: PageKey = up ? (edge ? 'Home' : 'PageUp') : (edge ? 'End' : 'PageDown');
    const expected = edge ? (up ? 1 : page.total) : page.focus + (up ? -page.width : page.width);
    if (Math.abs(expected - page.focus) <= 1 || !await tx.driver.permitsPageKey(key)) return this.move(tx, menu, direction);
    await this.assertMenu(tx, menu);
    diagnostic.event('settings.key', { kind: tx.kind, key, paneId: tx.paneId, previousFocus: menu.focusedKey });
    await this.navigationKey(tx, menu, key);
    let next = await this.waitMenu(tx);
    if (menuState(next) === menuState(menu)) {
      // Allow a delayed redraw once. An older picker may ignore the key;
      // use regular guarded arrows from the settled unchanged menu in that case.
      await delay(100);
      next = await this.waitMenu(tx);
      if (menuState(next) === menuState(menu)) {
        tx.pageKeysIgnored = true;
        return this.move(tx, next, direction);
      }
    }
    const disclosure = next.options.some(row => row.disclosure);
    const landed = disclosure ? pageRange(next) : numberedPage(next);
    if (!landed || landed.total !== page.total || landed.focus !== expected
      || landed.first > page.last + 1 || landed.last < page.first - 1
      || (up ? landed.first >= page.first : landed.last <= page.last)) {
      throw new SessionSettingError(t('native.pagingMismatch'));
    }
    if (disclosure) tx.pageKeysIgnored = true;
    return next;
  }
  private async collect(tx: Transaction, initial: Menu, command: string, detail?: string): Promise<Catalog> {
    const options = new Map<number, MenuOption>();
    let menu = initial, currentKey = tx.kind === 'effort' ? initial.focusedKey : initial.currentKey, steps = 0, complete = true;
    let sessionOnly = false;
    const add = (page: Menu) => {
      if (page.sessionOnlyKey === 's') sessionOnly = true;
      if (tx.kind === 'model' && page.currentKey) {
        if (currentKey && page.currentKey !== currentKey) throw new SessionSettingError(t('native.currentModelChanged'));
        currentKey = page.currentKey;
      }
      if (tx.kind === 'model' && currentKey && page.options.some(option => option.key === currentKey && !option.current)) {
        throw new SessionSettingError(t('native.currentMarkerChanged'));
      }
      for (const option of page.options) {
        const previous = options.get(option.ordinal);
        if (previous && (previous.key !== option.key || previous.description !== option.description || previous.disabled !== option.disabled)) throw new SessionSettingError(t('native.optionsChanged'));
        options.set(option.ordinal, option);
      }
    };
    add(menu);
    const scanPages = async () => {
      const directions: ('Up' | 'Down')[] = menu.moreBeforeCount !== undefined && menu.moreAfterCount !== undefined && menu.moreAfterCount < menu.moreBeforeCount ? ['Down', 'Up'] : ['Up', 'Down'];
      for (const direction of directions) {
        while (direction === 'Up' ? menu.hasMoreBefore : menu.hasMoreAfter) {
          const page = numberedPage(menu);
          // An earlier page may already contain all rows on the return path.
          if (page && options.size === page.total && [...options.values()].every(row => row.ordinal >= 1 && row.ordinal <= page.total && !row.disclosure)) return;
          if (tx.kind !== 'model' || ++steps > 128 || options.size > 64) { complete = false; return; }
          menu = await this.scanStep(tx, menu, direction);
          add(menu);
        }
      }
    };
    await scanPages();
    const disclosure = [...options.values()].find(option => option.disclosure);
    if (complete && disclosure && disclosure.disclosure !== 'expanded') {
      while (menu.focusedKey !== disclosure.key && ++steps <= 128) {
        const focused = menu.options.find(option => option.focused);
        if (!focused) break;
        menu = await this.move(tx, menu, focused.ordinal < disclosure.ordinal ? 'Down' : 'Up');
        add(menu);
      }
      if (menu.focusedKey === disclosure.key && menu.disclosureAction === 'expand' && !menu.sessionOnlyKey && menu.cancelKey === 'Escape') {
        await this.assertMenu(tx, menu);
        await tx.driver.key('Enter', tx.paneId);
        menu = await this.waitMenu(tx, undefined, true);
        add(menu);
        await scanPages();
      } else complete = false;
    }
    const ordered = [...options.values()].sort((a, b) => a.ordinal - b.ordinal);
    // A native disclosure marker has no model number. Some accessible layouts
    // count it. Accept either form only when the numbered sequence is complete.
    const numbered = ordered.filter(option => Number.isInteger(option.ordinal));
    if (!ordered.length || ordered.length > 64 || numbered.some((option, index) => option.ordinal !== index + 1)
      || !currentKey || !ordered.some(option => option.key === currentKey && !option.disclosure)) complete = false;
    if (!sessionOnly || menu.cancelKey !== 'Escape') complete = false;
    if (!complete) detail = [detail, t('native.menuIncomplete')].filter(Boolean).join(' ');
    return { kind: tx.kind, paneId: tx.paneId, command, options: ordered.slice(0, 64), currentKey, complete, detail, menu };
  }
  private async close(tx: Transaction, expected?: Menu, readOnly = false): Promise<void> {
    if (!(expected && tx.driver.guardsViewport && tx.lastMenu === expected && expected.cancelKey === 'Escape')) {
      const frame = await this.observe(tx, 'before-close');
      if (isIdleEmptyComposer(frame.viewport)) return;
      if (frame.parsed.state !== 'menu' || frame.parsed.cancelKey !== 'Escape') throw new SessionSettingError(t('native.notThisMenuNoEsc'));
      if (expected && menuState(frame.parsed) !== menuState(expected)) throw new SessionSettingError(t('native.menuChangedNoEsc'));
    }
    if (expected && (readOnly || tx.kind === 'effort')) await this.navigationKey(tx, expected, 'Escape');
    else await tx.driver.key('Escape', tx.paneId);
    await this.waitIdle(tx);
  }
  private async cleanup(tx: Transaction): Promise<void> {
    if (tx.preserveFrame || !tx.lastMenu) return;
    // Cleanup has its own bounded observation window. It still refuses to send
    // Escape to a changed pane or an unrecognized/other-kind dialog.
    try { await this.close({ ...tx, deadline: Date.now() + 5000, lastMenu: undefined }, tx.lastMenu); }
    catch (error) { diagnostic.event('settings.cleanup.skipped', { kind: tx.kind, paneId: tx.paneId, error: errorDetails(error) }, 'warn'); }
  }
  private issueTicket(context: SettingContext, snapshot: Omit<SessionSettingSnapshot, 'token' | 'observedAt'>, baseline?: Ticket['baseline'], values?: (string | undefined)[]): SessionSettingSnapshot {
    const observedAt = Date.now();
    for (const [token, ticket] of this.tickets) if (ticket.expires <= observedAt || (ticket.context.targetKey === context.targetKey && ticket.context.sessionId === context.sessionId && ticket.kind === snapshot.kind)) this.tickets.delete(token);
    while (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!);
    const choices = new Map(snapshot.options.flatMap((option, index) => option.disabled ? []
      : [[option.id, { label: option.label, description: option.description, ...(values?.[index] !== undefined && { value: values[index] }) }] as const]));
    const token = randomUUID(), menu = snapshot.options.map(({ label, description, disabled }, index) => ({ label, description, disabled, ...(values?.[index] !== undefined && { value: values[index] }) }));
    this.tickets.set(token, { context, paneId: snapshot.paneId, kind: snapshot.kind, complete: snapshot.complete, choices, baseline, menu, command: snapshot.command, expires: observedAt + sessionSettingTicketLifetimeMs });
    return { ...snapshot, token, observedAt: new Date(observedAt).toISOString() };
  }
  private snapshot(context: SettingContext, catalog: Catalog): SessionSettingSnapshot {
    const options = catalog.options.filter(option => !option.disclosure).map(option =>
      ({ id: randomUUID(), label: option.label, description: option.description, current: option.key === catalog.currentKey, disabled: option.disabled }));
    const snapshot = { kind: catalog.kind, sessionId: context.sessionId, paneId: catalog.paneId, command: catalog.command, options,
      currentOptionId: options.find(option => option.current)?.id, complete: catalog.complete, detail: catalog.detail, nativeFeedback: catalog.nativeFeedback,
      ...(catalog.kind === 'effort' && { ultracodeAvailable: catalog.menu.ultracode !== undefined }) };
    return this.issueTicket(context, snapshot, { state: catalogState(catalog), currentKey: catalog.currentKey });
  }
  private async readCatalog(driver: SettingDriver, context: SettingContext, kind: SessionSettingKind, options?: SettingReadOptions): Promise<Catalog> {
    return diagnostic.operation('settings.get', { workspaceId: context.workspaceId, sessionId: context.sessionId, kind }, async () => {
      const tx = await this.transaction(driver, context, kind, options);
      try {
        const opened = await this.open(tx), catalog = await this.collect(tx, opened.menu, opened.command, opened.detail);
        await this.close(tx, catalog.menu, true);
        diagnostic.event('settings.catalog', { kind, command: catalog.command, complete: catalog.complete, optionCount: catalog.options.length, currentKey: catalog.currentKey });
        return catalog;
      } catch (error) { await this.cleanup(tx); throw error; }
    });
  }
  async get(driver: SettingDriver, context: SettingContext, kind: SessionSettingKind, options?: SettingReadOptions): Promise<SessionSettingSnapshot> {
    return this.snapshot(context, await this.readCatalog(driver, context, kind, options));
  }
  /** Only the main process passes the machine's model list here. The renderer
   * receives opaque IDs and cannot supply a model label, value or terminal command.
   * Rows the native menu cannot tell apart (same name and description) stay
   * disabled: the menu flow could not confirm which one it chose. */
  bindChoices(context: SettingContext, paneId: string, choices: SettingChoices): SessionSettingSnapshot {
    const options = choices.options.map((option, index) => ({ id: randomUUID(), label: option.label, description: option.description, current: false,
      disabled: !!option.disabled || choices.options.some((other, at) => at !== index && sameChoice(other, option)) }));
    return this.issueTicket(context, { kind: choices.kind, command: choices.command, complete: choices.complete, detail: choices.detail,
      sessionId: context.sessionId, paneId, options }, undefined, choices.options.map(option => option.value));
  }
  /** Type an inline command onto a settled idle composer. Claude often repaints
   * once more after a previous command (hints, notices); the dispatch guard then
   * refuses before sending anything, so one retry on a fresh settled frame is safe. */
  private async typeInline(tx: Transaction, command: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let frame = await this.observe(tx, 'inline-settle', true);
      for (let wait = 0; !(isIdleEmptyComposer(frame.viewport) && frame.stable) && wait < 25; wait++) {
        await delay(80);
        frame = await this.observe(tx, 'inline-settle', true);
      }
      if (!isIdleEmptyComposer(frame.viewport)) throw new SessionSettingError(t('native.composerBusyNoCommand'));
      tx.history = priorComposerHistory(frame.viewport);
      tx.inlineCommand = command;
      try { await tx.driver.type(command, tx.paneId); return; }
      catch (error) {
        // Only a guard refusal before dispatch; a pasted draft fails the idle check above.
        if (attempt > 0 || !keysNotSent(error)) throw error;
        diagnostic.event('settings.inline_retry', { kind: tx.kind, paneId: tx.paneId, reason: error.message });
      }
    }
  }
  /** `/effort ultracode on|off`: session-only, independent of the effort level. */
  async setUltracode(driver: SettingDriver, context: SettingContext, on: boolean): Promise<{ ultracode: boolean; message: string }> {
    const command = `/effort ultracode ${on ? 'on' : 'off'}`;
    return diagnostic.operation('settings.ultracode', { workspaceId: context.workspaceId, sessionId: context.sessionId, state: on ? 'on' : 'off' }, async () => {
      const tx = await this.transaction(driver, context, 'effort');
      diagnostic.capture('settings.input', command, { kind: 'effort', phase: 'ultracode', paneId: tx.paneId });
      await this.typeInline(tx, command);
      let previous: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        const frame = await this.observe(tx, 'ultracode-confirm');
        const message = isIdleEmptyComposer(frame.viewport) ? readSettingReceipt(frame.viewport, 'effort', tx.history ?? [], command) : undefined;
        if (message && message === previous) return { ultracode: ultracodeReceipt(on, message), message };
        previous = message;
        await delay(80);
      }
      throw new SessionSettingError(t('native.ultracodeNoReceipt'));
    });
  }
  /** One typed command instead of opening, paging and navigating the menu:
   * `/model <alias>` or `/effort <level>`. Claude saves these as the default for
   * new sessions. Returns undefined, keeping the ticket, when the choice has no
   * inline name; the caller then uses set(). */
  async setInline(driver: SettingDriver, context: SettingContext, token: string, optionId: string): Promise<SessionSettingSnapshot | undefined> {
    const ticket = this.tickets.get(token);
    const choice = ticket?.choices.get(optionId);
    if (!ticket || !choice || ticket.expires <= Date.now() || ticket.context.targetKey !== context.targetKey || ticket.context.sessionId !== context.sessionId) throw new SessionSettingError(t('native.optionExpired'));
    const argument = inlineSettingArgument(ticket.kind, choice);
    if (!argument) return;
    this.tickets.delete(token); // An uncertain mutation must never be replayed with the same ticket.
    const command = `${ticket.kind === 'model' ? '/model' : '/effort'} ${argument}`;
    return diagnostic.operation('settings.set_inline', { workspaceId: context.workspaceId, sessionId: context.sessionId, kind: ticket.kind, command }, async () => {
      const tx = await this.transaction(driver, context, ticket.kind);
      if (tx.paneId !== ticket.paneId) throw new SessionSettingError(t('native.paneMoved'));
      const requested: MenuOption = { key: 'inline', ordinal: 0, label: choice.label, description: choice.description, current: false, focused: true };
      diagnostic.capture('settings.input', command, { kind: tx.kind, phase: 'inline', paneId: tx.paneId });
      diagnostic.event('settings.apply', { kind: tx.kind, command, scope: 'default', paneId: tx.paneId });
      await this.typeInline(tx, command);
      try {
        const { confirmed, feedback } = await this.waitApplied(tx, requested);
        const options = ticket.menu.map(item => ({ id: randomUUID(), label: item.label, description: item.description, disabled: item.disabled,
          current: !item.disabled && sameChoice(item, choice) }));
        diagnostic.event('settings.verified', { kind: tx.kind, command, paneId: tx.paneId, scope: 'default' });
        return this.issueTicket(context, { kind: ticket.kind, sessionId: context.sessionId, paneId: tx.paneId, command: ticket.command, options,
          currentOptionId: options.find(option => option.current)?.id, complete: ticket.complete, nativeFeedback: feedback,
          detail: [feedback, confirmed && t('native.rereadAfterReply')].filter(Boolean).join(' ') || undefined }, undefined, ticket.menu.map(item => item.value));
      } catch (error) {
        if (error instanceof PendingHookConfirmation) throw error;
        throw new SessionSettingError(t('native.commandSentUnverified', { detail: error instanceof Error ? error.message : '' }).trimEnd());
      }
    });
  }
  async set(driver: SettingDriver, context: SettingContext, token: string, optionId: string): Promise<SessionSettingSnapshot> {
    const ticket = this.tickets.get(token);
    const choice = ticket?.choices.get(optionId);
    if (!ticket || !choice || ticket.expires <= Date.now() || ticket.context.targetKey !== context.targetKey || ticket.context.sessionId !== context.sessionId) throw new SessionSettingError(t('native.optionExpired'));
    if (!ticket.complete) throw new SessionSettingError(t('native.menuNotConfirmed'));
    this.tickets.delete(token); // An uncertain mutation must never be replayed with the same ticket.
    return diagnostic.operation('settings.set', { workspaceId: context.workspaceId, sessionId: context.sessionId, kind: ticket.kind }, async () => {
      const tx = await this.transaction(driver, context, ticket.kind);
      if (tx.paneId !== ticket.paneId) throw new SessionSettingError(t('native.paneMoved'));
      let submitted = false;
      try {
        const opened = await this.open(tx), catalog = await this.collect(tx, opened.menu, opened.command, opened.detail);
        if (!catalog.complete || (ticket.baseline && (catalogState(catalog) !== ticket.baseline.state || catalog.currentKey !== ticket.baseline.currentKey))) throw new SessionSettingError(t('native.menuOrSettingChanged'));
        const candidates = catalog.options.filter(option => !option.disclosure && sameChoice(option, choice));
        if (candidates.length !== 1 || candidates[0].disabled) throw new SessionSettingError(t('native.optionAmbiguous'));
        const requested = candidates[0];
        if (catalog.currentKey === requested.key) {
          await this.close(tx, catalog.menu);
          return this.snapshot(context, catalog);
        }
        let menu = catalog.menu;
        for (let count = 0; menu.focusedKey !== requested.key; count++) {
          if (count >= 128) throw new SessionSettingError(t('native.cannotLocateOption'));
          const focused = catalog.options.find(option => option.key === menu.focusedKey);
          if (!focused) throw new SessionSettingError(t('native.focusUnconfirmed'));
          const backwards = requested.ordinal < focused.ordinal;
          menu = await this.move(tx, menu, tx.kind === 'model' ? backwards ? 'Up' : 'Down' : backwards ? 'Left' : 'Right');
          if ((tx.kind === 'model' && menu.currentKey && menu.currentKey !== catalog.currentKey)
            || menu.options.some(option => { const observed = catalog.options.find(item => item.ordinal === option.ordinal); return !observed || observed.key !== option.key || observed.description !== option.description || observed.disabled !== option.disabled || observed.disclosure !== option.disclosure; })) {
            throw new SessionSettingError(t('native.changedWhileLocating'));
          }
        }
        await this.assertMenu(tx, menu);
        if (menu.sessionOnlyKey !== 's') throw new SessionSettingError(t('native.noSessionOnly'));
        if (ticket.expires <= Date.now()) throw new SessionSettingError(t('native.choiceExpired'));
        diagnostic.event('settings.apply', { kind: tx.kind, optionKey: requested.key, scope: 'session', paneId: tx.paneId });
        submitted = true;
        await tx.driver.key('s', tx.paneId);
        const { confirmed, feedback } = await this.waitApplied(tx, requested);
        const verified = { ...catalog, currentKey: requested.key, nativeFeedback: feedback,
          detail: [catalog.detail, feedback, confirmed && t('native.rereadAfterReply')].filter(Boolean).join(' ') || undefined };
        diagnostic.event('settings.verified', { kind: tx.kind, currentKey: verified.currentKey, paneId: tx.paneId, scope: 'session' });
        return this.snapshot(context, verified);
      } catch (error) {
        if (!submitted) await this.cleanup(tx);
        if (error instanceof PendingHookConfirmation) throw error;
        if (submitted) throw new SessionSettingError(t('native.maybeApplied', { detail: error instanceof Error ? error.message : '' }).trimEnd());
        throw error;
      }
    });
  }
}
