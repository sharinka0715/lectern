import { useEffect, useRef, useState } from "react";
import { Box, Check, ChevronDown, Loader2, RefreshCw, X } from "lucide-react";
import type {
  NavigationSessionStatus,
  NativeStatusLineObservation,
  SessionSettingKind,
  SessionSettingsState,
  SessionStatus,
} from "../shared/types";
import { reportActionError } from "./diagnostics";
import { desktopState } from "./desktop-state";
import { settingMenuNeedsRefresh } from "../shared/session-setting-ticket";
import { tip } from "./Tooltip";
import {
  confirmedSettingOption,
  settingAvailability,
  validateSettingMenu,
} from "./session-settings-state";
import { localeTag, t } from '../shared/i18n';

/** "Model" / "Effort", in the current language. */
const names = (kind: SessionSettingKind) => t(kind === "model" ? 'settings.model' : 'settings.effort');
function settingErrorText(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.replace(/^Error invoking remote method 'lectern:(?:get|set)SessionSetting': (?:[\w.]*Error: )?/, "");
}
function observedTime(value: string) {
  const time = new Date(value);
  return Number.isFinite(+time)
    ? time.toLocaleTimeString(localeTag(), { hour12: false })
    : value;
}

export function SessionSettings({
  workspaceId,
  sessionId,
  paneId,
  status,
  navigationStatus,
  nativeInputReady,
  pendingSettingCommand,
  settingBusy,
  settings,
  statusLineManaged,
  statusLine,
  onBusyChange,
}: {
  workspaceId: string;
  sessionId: string;
  paneId?: string;
  status: SessionStatus;
  navigationStatus?: NavigationSessionStatus;
  nativeInputReady?: boolean;
  pendingSettingCommand?: SessionSettingKind;
  settingBusy?: boolean;
  settings?: SessionSettingsState;
  statusLineManaged?: boolean;
  statusLine?: NativeStatusLineObservation;
  onBusyChange(busy: boolean): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const [openKind, setOpenKind] = useState<SessionSettingKind>();
  // Main publishes each verified menu before completing the action. Use that
  // same source for invalidations and pane replacements, even while open.
  const menus = settings?.menus ?? {};
  const [pending, setPending] = useState<{
    kind: SessionSettingKind;
    action: "read" | "apply";
    optionId?: string;
  }>();
  const [failure, setFailure] = useState<{
    kind: SessionSettingKind;
    action: "read" | "apply";
    text: string;
  }>();
  const [announcement, setAnnouncement] = useState("");
  const availability = settingAvailability({
    paneId,
    status,
    navigationStatus,
    nativeInputReady,
    busy: !!pending || settingBusy || !!pendingSettingCommand,
  });
  // Browsing reads the machine's model list, never the conversation's pane,
  // which can be replying, awaiting permission, or under manual control.
  // Discovery can publish a pane ID before the watcher binds this session.
  // A settings snapshot exists as soon as that binding can accept menu reads.
  const canBrowse = !!paneId && !!settings && pending?.action !== "apply";
  const menu = openKind ? menus[openKind] : undefined;
  const current = confirmedSettingOption(menu);
  const reportedValue = (kind: SessionSettingKind) => statusLineManaged && (kind === "model"
    ? statusLine?.modelName || statusLine?.modelId : statusLine?.effort);
  const observedValue = openKind && (reportedValue(openKind) || settings?.observed?.[openKind]?.label);
  const reading = pending?.action === "read";
  const needsRefresh = settingMenuNeedsRefresh(menu);
  const localError = failure && failure.kind === openKind && (failure.action === "apply" || needsRefresh)
    ? failure.text : undefined;
  const error = localError || (openKind && needsRefresh && (settings?.errors
    ? settings.errors[openKind] : settings?.error));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
      busyCallback.current(false);
    };
  }, []);

  useEffect(() => {
    if (!openKind) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setOpenKind(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpenKind(undefined);
        container.current
          ?.querySelector<HTMLButtonElement>(
            `button[data-setting-kind="${openKind}"]`,
          )
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [openKind]);

  async function read(kind: SessionSettingKind) {
    if (!canBrowse || !paneId || !workspaceId || !sessionId) return;
    const request = ++generation.current;
    setOpenKind(kind);
    setFailure(undefined);
    setAnnouncement("");
    setPending({ kind, action: "read" });
    try {
      validateSettingMenu(
        await window.desktop.getSessionSetting(workspaceId, sessionId, kind),
        kind,
        sessionId,
        paneId,
      );
    } catch (failure) {
      reportActionError(failure, `Reading the ${kind} list failed`);
      if (alive.current && generation.current === request)
        setFailure({ kind, action: "read", text: settingErrorText(failure) });
    } finally {
      if (alive.current && generation.current === request) setPending(undefined);
    }
  }

  async function apply(kind: SessionSettingKind, optionId: string) {
    const source = menus[kind];
    const sourceOption = source?.options.find(
      (option) => option.id === optionId,
    );
    if (!availability.allowed || !paneId || !source?.complete || !sourceOption || sourceOption.disabled)
      return;
    // The main process may invalidate a snapshot after the dialog opens.
    if (settingMenuNeedsRefresh(source)) {
      await read(kind);
      return;
    }
    // The effective level in statusLine can also come from an Auto selection.
    // Skip a write only when this pane previously confirmed the exact menu row.
    const observed = settings?.observed?.[kind];
    if (confirmedSettingOption(source)?.id === optionId && observed?.label === sourceOption.label
      && observed.description === sourceOption.description) {
      setOpenKind(undefined);
      return;
    }
    const request = ++generation.current;
    setFailure(undefined);
    setPending({ kind, action: "apply", optionId });
    busyCallback.current(true);
    try {
      const next = validateSettingMenu(
        await window.desktop.setSessionSetting(
          workspaceId,
          sessionId,
          source.token,
          optionId,
          desktopState().settingSwitch,
        ),
        kind,
        sessionId,
        paneId,
      );
      if (!alive.current || generation.current !== request) return;
      const selected = confirmedSettingOption(next);
      // A write succeeds only with confirmation from the selected business pane.
      if (!selected)
        throw new Error(t('settings.notConfirmed'));
      setAnnouncement(t('settings.confirmed', { kind, label: selected.label }));
      if (!next.nativeFeedback) setOpenKind(undefined);
    } catch (failure) {
      reportActionError(failure, `Switching the ${kind} was not confirmed`);
      if (alive.current && generation.current === request) {
        setFailure({ kind, action: "apply", text: settingErrorText(failure) });
      }
    } finally {
      if (alive.current && generation.current === request) {
        setPending(undefined);
        busyCallback.current(false);
      }
    }
  }

  /** `/effort ultracode on|off`, this session only. */
  async function toggleUltracode(on: boolean) {
    const request = ++generation.current;
    setFailure(undefined);
    setPending({ kind: "effort", action: "apply", optionId: "ultracode" });
    busyCallback.current(true);
    try {
      const verified = await window.desktop.setUltracode(workspaceId, sessionId, on);
      if (!alive.current || generation.current !== request) return;
      setAnnouncement(t(verified ? 'settings.ultracodeOn' : 'settings.ultracodeOff'));
    } catch (failure) {
      reportActionError(failure, "切换 Ultracode 未确认");
      if (alive.current && generation.current === request) setFailure({ kind: "effort", action: "apply", text: settingErrorText(failure) });
    } finally {
      if (alive.current && generation.current === request) { setPending(undefined); busyCallback.current(false); }
    }
  }

  return (
    <div
      className="session-settings"
      ref={container}
      data-setting-busy={pending?.action === "apply" || !!settingBusy}
      data-setting-initialization={settings?.initialization ?? "pending"}
    >
      {(["model", "effort"] as const).map((kind) => {
        const confirmed = confirmedSettingOption(menus[kind]);
        const restored = settings?.observed?.[kind];
        const active = pending?.kind === kind;
        const reported = reportedValue(kind);
        const label = reported || confirmed?.label || restored?.label || names(kind);
        const title = reported
          ? t('settings.reportedBy', { kind, value: kind === "model" ? statusLine?.modelId || reported : reported })
          : confirmed || restored
            ? t('settings.lastConfirmed', { kind, value: confirmed?.label || restored?.label })
            : t('settings.notReported', { kind });
        return (
          <button
            className={`session-setting-trigger${openKind === kind ? " selected" : ""}`}
            type="button"
            key={kind}
            data-setting-kind={kind}
            data-current-option-id={statusLineManaged ? "" : confirmed?.id ?? ""}
            aria-label={t('settings.choose', { kind })}
            aria-haspopup="dialog"
            aria-expanded={openKind === kind}
            disabled={!canBrowse}
            onClick={() => {
              if (openKind === kind) setOpenKind(undefined);
              else if (settingMenuNeedsRefresh(menus[kind])) void read(kind);
              else {
                setFailure(undefined);
                if (pending?.action === "read") { ++generation.current; setPending(undefined); }
                setOpenKind(kind);
              }
            }}
            {...tip(label === names(kind) ? names(kind) : t('settings.labelWithValue', { name: names(kind), value: label }), [
              t('settings.sentence', { text: title }),
              t(kind === "model" ? 'settings.modelHelp' : 'settings.effortHelp'),
              kind === "effort" && settings?.ultracode ? t('settings.ultracodeActive') : "",
              t('settings.switchModeHelp'),
            ].filter(Boolean).join("\n"))}
          >
            {kind === "model" && (
              <span className="mini-claude" aria-hidden="true">
                <Box size={14} strokeWidth={1.7} />
              </span>
            )}
            <span>{label}</span>
            {active ? (
              <Loader2 size={11} className="rotating" />
            ) : (
              <ChevronDown size={11} />
            )}
          </button>
        );
      })}
      <span
        className="settings-sr-only"
        role="status"
        data-setting-result={announcement}
      >
        {announcement}
      </span>
      {openKind && (
        <section
          className="session-setting-menu"
          role="dialog"
          aria-label={t('settings.choose', { kind: openKind })}
          data-setting-menu={openKind}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
              return;
            const options = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button[role="option"]:not(:disabled)',
              ),
            );
            if (!options.length) return;
            event.preventDefault();
            const index = options.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % options.length
                    : (index <= 0 ? options.length : index) - 1;
            options[next].focus();
          }}
        >
          <div className="setting-menu-heading">
            <strong>{names(openKind)}</strong>
            <button
              className="icon-button"
              type="button"
              aria-label={t('settings.closeMenu')}
              onClick={() => setOpenKind(undefined)}
            >
              <X size={14} />
            </button>
          </div>
          {reading && !menu ? (
            <div className="setting-menu-loading" role="status">
              <Loader2 size={15} className="rotating" />
              <span>{t('settings.readingModels')}</span>
            </div>
          ) : (
            <>
              {menu && (
                <>
                  <div className="setting-current">
                    {current ? (
                      <>
                        {reading || needsRefresh ? t('settings.previous') : ""}
                        {t(openKind === "effort" ? 'settings.menuEffort' : 'settings.menuModel')} <strong>{current.label}</strong>
                      </>
                    ) : observedValue ? (
                      <>{t('settings.reportedValue')} <strong>{observedValue}</strong></>
                    ) : t('settings.noCurrentValue')}
                  </div>
                  <div
                    className="setting-options"
                    role="listbox"
                    aria-label={t('settings.available', { kind: openKind })}
                  >
                    {menu.options.map((option) => (
                      <button
                        type="button"
                        className="setting-option"
                        role="option"
                        key={option.id}
                        data-option-id={option.id}
                        data-current={option.current}
                        aria-selected={option.current}
                        disabled={needsRefresh || !availability.allowed || option.disabled}
                        onClick={() => void apply(openKind, option.id)}
                        title={
                          option.description
                            ? `${option.label}\n${option.description}`
                            : option.label
                        }
                      >
                        <span>
                          <strong>{option.label}</strong>
                          {option.description && (
                            <small>{option.description}</small>
                          )}
                        </span>
                        {pending?.optionId === option.id ? (
                          <Loader2 size={13} className="rotating" />
                        ) : option.current ? (
                          <Check size={13} />
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {openKind === "effort" && menu.ultracodeAvailable && (
                    <button type="button" className="setting-option setting-ultracode" role="switch"
                      aria-checked={!!settings?.ultracode} data-ultracode={settings?.ultracode === undefined ? "unknown" : String(settings.ultracode)}
                      disabled={!availability.allowed || !!pending} onClick={() => void toggleUltracode(!settings?.ultracode)}
                      title={t('settings.ultracodeTitle')}>
                      <span><strong>Ultracode</strong><small>{t('settings.ultracodeNote')}{settings?.ultracode === undefined ? t('settings.stateUnconfirmed') : ""}</small></span>
                      {pending?.optionId === "ultracode" ? <Loader2 size={13} className="rotating" />
                        : <span className="setting-switch" aria-hidden="true" data-on={!!settings?.ultracode} />}
                    </button>
                  )}
                  {openKind === "effort" && menu.ultracodeAvailable === false && (
                    <p className="setting-menu-note">{t('settings.noUltracode')}</p>
                  )}
                  {!menu.options.length && !menu.detail && (
                    <p className="setting-menu-note">
                      {t('settings.noOptions', { kind: openKind })}
                    </p>
                  )}
                  {!menu.complete && (
                    <p className="setting-menu-warning">
                      {t('settings.menuIncomplete')}
                    </p>
                  )}
                  <div className="setting-menu-source" title={t('settings.listSourceTitle')}>
                    {t('settings.listSource', { cli: settings?.cliVersion ? `Claude Code ${settings.cliVersion}` : "Claude Code" })}
                    <time dateTime={menu.observedAt}>
                      {observedTime(menu.observedAt)}
                    </time>
                  </div>
                  {menu.detail && (
                    <p className="setting-menu-note">{menu.detail}</p>
                  )}
                  {menu.nativeFeedback && !menu.detail?.includes(menu.nativeFeedback) && (
                    <p className="setting-menu-note">{menu.nativeFeedback}</p>
                  )}
                </>
              )}
              {error && (
                <div className="setting-menu-error" role="alert">
                  {error}
                </div>
              )}
              <div className="setting-menu-footer">
                <span role="status">
                  {pending?.action === "apply" ? t('settings.confirmingChoice')
                    : reading ? t('settings.readingModels')
                    : !availability.allowed ? availability.reason
                    : needsRefresh ? t('settings.optionsNotReady')
                    : t(desktopState().settingSwitch === "inline" ? 'settings.inlineFooter' : 'settings.menuFooter')}
                </span>
                {needsRefresh && !pending && (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={t('settings.reread', { kind: openKind })}
                    title={t('settings.rereadTitle')}
                    onClick={() => void read(openKind)}
                    disabled={!canBrowse}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
