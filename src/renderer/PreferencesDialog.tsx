import { useEffect, useRef, useState } from "react";
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  FileCode,
  FileInput,
  FolderTree,
  History,
  LogIn,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Text,
  Trash2,
  X,
} from "lucide-react";
import type { Workspace } from "../shared/types";
import { MIN_HISTORY_PAGE_MIB, MAX_HISTORY_PAGE_MIB } from '../shared/history-paging';
import { workspaceMachines } from "./workspace-machines";
import { CodePreview } from "./CodePreview";
import { openSshLogin } from "./ssh-login";
import { connectSshMachine, disconnectSshMachine, setMachineConnection, sshDisconnectHint, sshMachines, useMachineConnections, type SshMachine } from "./ssh-machines";
import { SshConfigImportDialog } from "./SshConfigImportDialog";
import { UpdateSettings } from "./UpdatePrompt";
import { QuitPreferenceSetting } from "./QuitDialog";
import { SshConnectionSetting } from "./SshConnectionSetting";
import { defaultQuitPreferences } from "../shared/quit";
import { updateText } from "../shared/update-strings";
import { timeZoneChoices, zoneOffset } from "./quota-time";
import {
  chatLayoutRanges,
  composerLineRange,
  defaultAppearance,
  defaultChatLayout,
  defaultPreview,
  defaultSessionOptions,
  archiveKey,
  restoreSessions,
  maxConversationWidth,
  moveProject,
  orderProjects,
  previewRanges,
  previewToggles,
  rowSpacingRange,
  setDesktop,
  useDesktopState,
  validHost,
  type ConnectionProfile,
} from "./desktop-state";
import { dateTimeText, t, type LocalePreference, type MessageKey } from '../shared/i18n';
import { promptCacheTtlPreset, promptCacheTtlPresets, type PromptCacheTtlPreset } from '../shared/prompt-cache';
import type { DialogHookStatus } from '../shared/dialog-hooks';
import type { LocaleState } from '../shared/types';
import type { SshMasterState } from '../shared/ssh-connections';
import { reportActionError } from './diagnostics';
import { showToast } from './ContextMenu';

const cacheTtlLabels: Record<PromptCacheTtlPreset, MessageKey> = {
  default: 'prefs.cacheTtlDefault', 'both-5m': 'prefs.cacheTtlBoth5m', 'both-1h': 'prefs.cacheTtlBoth1h',
  'main-1h-other-5m': 'prefs.cacheTtlMain1hOther5m',
};

const previewSample = () => `${t('prefs.sampleCode')}
def summarize(path: str, limit: int = 20) -> dict:
    rows = [line.strip() for line in open(path, encoding="utf-8") if line.strip()]
    return {"path": path, "count": len(rows), "preview": rows[:limit], "note": "${t('prefs.sampleCodeNote')}"}
`;

/** The open chat's recording hooks in words. */
function hookStatusText(status: DialogHookStatus) {
  if (status.state === 'active') return 'prefs.dialogHooksActive' as const;
  if (status.state === 'waiting') return 'prefs.dialogHooksWaiting' as const;
  if (status.state === 'unavailable') return status.reason === 'no-folder' ? 'prefs.dialogHooksNoFolder' as const : 'prefs.dialogHooksNotLaunched' as const;
  return 'prefs.dialogHooksOff' as const;
}

export function PreferencesDialog({
  workspaces,
  platform,
  demo,
  newMachine = false,
  onClose,
  hookStatus,
}: {
  workspaces: Workspace[];
  platform: string;
  demo?: boolean;
  newMachine?: boolean;
  onClose(): void;
  /** The open chat's recording hooks (Settings → Session). */
  hookStatus?: DialogHookStatus;
}) {
  const settings = useDesktopState();
  // About 400 zones with their offsets, listed once per opening of the dialog.
  const [zoneChoices] = useState(() => timeZoneChoices());
  const connectionOf = useMachineConnections();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"appearance" | "chatLayout" | "preview" | "history" | "session" | "projects" | "connections" | "trash" | "updates">(
    newMachine ? "connections" : "appearance",
  );
  const [editing, setEditing] = useState<ConnectionProfile | undefined>(newMachine ? { id: "", name: "", host: "" } : undefined);
  const [connectionError, setConnectionError] = useState("");
  const [importingSsh, setImportingSsh] = useState(false);
  const [quitReset, setQuitReset] = useState(0);
  // The language lives in the main process, which also rebuilds the menu.
  const [language, setLanguage] = useState<LocaleState>();
  useEffect(() => {
    let live = true;
    void window.desktop.localeState().then(state => { if (live) setLanguage(state); }).catch(() => {});
    const off = window.desktop.onLocaleChange(state => { if (live) setLanguage(state); });
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const sorted = orderProjects(workspaces, settings.projectOrder);
  function submitConnection(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const name = String(fields.get("name")).trim(),
      host = String(fields.get("host")).trim(),
      portText = String(fields.get("port")).trim();
    const port = portText ? Number(portText) : undefined;
    if (
      !validHost(host) ||
      (port !== undefined &&
        (!/^\d+$/.test(portText) || port < 1 || port > 65535))
    ) {
      setConnectionError(t('prefs.invalidHost'));
      return;
    }
    const value = {
      id: editing?.id || crypto.randomUUID(),
      name: name || host,
      host,
      port,
    };
    if (settings.connections.some(c => c.id !== value.id && c.host === host && c.port === port)) {
      setConnectionError(t('prefs.machineSaved'));
      return;
    }
    const exists = settings.connections.some((c) => c.id === value.id);
    setDesktop({
      connections: exists
        ? settings.connections.map((c) => (c.id === value.id ? value : c))
        : [...settings.connections, value],
    });
    setEditing(undefined);
    setConnectionError("");
    if (newMachine) onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="modal desktop-preferences"
      onCancel={onClose}
      aria-label={t('prefs.title')}
    >
      <header className="pref-header">
        <h2>{t('prefs.title')}</h2>
        <button className="icon-button" aria-label={t('prefs.close')} onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="pref-layout">
        <nav aria-label={t('prefs.categories')}>
          {(
            [
              ["appearance", t('prefs.tabAppearance'), Monitor],
              ["chatLayout", t('prefs.tabChatLayout'), Text],
              ["preview", t('prefs.tabPreview'), FileCode],
              ["history", t('prefs.tabHistory'), History],
              ["session", t('prefs.tabSession'), SlidersHorizontal],
              ["projects", t('prefs.tabProjects'), FolderTree],
              ["connections", t('prefs.tabConnections'), Server],
              ["trash", t('prefs.tabTrash'), ArchiveRestore],
              ["updates", updateText(undefined, "settingsTab"), RefreshCw],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <section className="pref-section">
          {tab === "appearance" && (
            <>
              <h3>{t('prefs.tabAppearance')}</h3>
              <label>
                {t('prefs.language')}
                <select aria-label={t('prefs.languageLabel')} value={language?.preference ?? "system"} disabled={!language}
                  onChange={e => void window.desktop.setLocalePreference(e.target.value as LocalePreference).then(setLanguage)}>
                  <option value="system">{t('prefs.languageSystem', { name: t(language?.system === "en" ? 'prefs.languageEn' : 'prefs.languageZh') })}</option>
                  <option value="zh-CN">{t('prefs.languageZh')}</option>
                  <option value="en">{t('prefs.languageEn')}</option>
                </select>
              </label>
              <label>
                {t('prefs.theme')}
                <select
                  aria-label={t('prefs.themeLabel')}
                  value={settings.theme}
                  onChange={(e) =>
                    setDesktop({
                      theme: e.target.value as typeof settings.theme,
                    })
                  }
                >
                  <option value="system">{t('prefs.themeSystem')}</option>
                  <option value="light">{t('prefs.themeLight')}</option>
                  <option value="dark">{t('prefs.themeDark')}</option>
                </select>
              </label>
              <label>
                {t('prefs.fontSize')}
                <span>
                  <input
                    aria-label={t('prefs.fontSize')}
                    type="range"
                    min="14"
                    max="20"
                    step="1"
                    value={settings.fontSize}
                    onChange={(e) => setDesktop({ fontSize: +e.target.value })}
                  />
                  <output>{settings.fontSize} px</output>
                </span>
              </label>
              <label>
                {t('prefs.rowSpacing')}
                <span>
                  <input aria-label={t('prefs.rowSpacing')} type="range" min={rowSpacingRange.min} max={rowSpacingRange.max}
                    step={rowSpacingRange.step} value={settings.rowSpacing} aria-valuetext={`${settings.rowSpacing}%`}
                    onChange={e => setDesktop({ rowSpacing: e.currentTarget.valueAsNumber })} />
                  <output>{settings.rowSpacing}%</output>
                </span>
              </label>
              <p>{t('prefs.rowSpacingHelp')}</p>
              <label>
                {t('prefs.composerMax')}
                <span>
                  <input
                    aria-label={t('prefs.composerMax')}
                    type="range"
                    min={composerLineRange.min}
                    max={composerLineRange.max}
                    step="1"
                    value={settings.composerMaxLines}
                    aria-valuetext={t('prefs.lines', { count: settings.composerMaxLines })}
                    onChange={(e) =>
                      setDesktop({ composerMaxLines: +e.target.value })
                    }
                  />
                  <output>{t('prefs.lines', { count: settings.composerMaxLines })}</output>
                </span>
              </label>
              <label>
                {t('prefs.replyDetail')}
                <select
                  aria-label={t('prefs.replyDetail')}
                  value={settings.replyDetail}
                  onChange={e => setDesktop({ replyDetail: e.target.value as typeof settings.replyDetail })}
                >
                  <option value="compact">{t('prefs.replyCompact')}</option>
                  <option value="individual">{t('prefs.replyIndividual')}</option>
                </select>
              </label>
              <label>{t('prefs.showCacheTtl')}
                <input type="checkbox" checked={settings.showCacheTtl} onChange={e => setDesktop({ showCacheTtl: e.currentTarget.checked })} />
              </label>
              <label>{t('prefs.showQuota')}
                <input type="checkbox" checked={settings.showSubscriptionQuota} onChange={e => setDesktop({ showSubscriptionQuota: e.currentTarget.checked })} />
              </label>
              <label>
                {t('prefs.quotaZone')}
                <select aria-label={t('prefs.quotaZoneLabel')} value={settings.quotaTimeZone} disabled={!settings.showSubscriptionQuota}
                  onChange={e => setDesktop({ quotaTimeZone: e.target.value })}>
                  <option value="">{t('prefs.localZone', { offset: zoneOffset() })}</option>
                  {zoneChoices.map(({ zone, offset }) => <option key={zone} value={zone}>{t('prefs.zoneOption', { zone, offset })}</option>)}
                </select>
              </label>
              <p>{t('prefs.quotaHelp')}</p>
              <button className="pref-action" onClick={() => setDesktop(defaultAppearance)}>
                {t('prefs.resetAppearance')}
              </button>
            </>
          )}
          {tab === "chatLayout" && (
            <>
              <h3>{t('prefs.tabChatLayout')}</h3>
              <p>{t('prefs.chatLayoutHelp')}</p>
              {chatLayoutRanges.map(({ key, label, min, max, step, unit }) => (
                <label key={key}>
                  {t(label)}
                  <span>
                    <input type="range" aria-label={t(label)} min={min} max={max} step={step}
                      value={settings[key]} aria-valuetext={`${settings[key]}${unit}`}
                      onChange={e => setDesktop({ [key]: e.currentTarget.valueAsNumber })} />
                    <output>{settings[key]}{unit}</output>
                  </span>
                </label>
              ))}
              <figure className="pref-chat-preview">
                <figcaption>{t('prefs.layoutPreview')}</figcaption>
                <div className="pref-preview-column" style={{ width: `${100 * settings.conversationWidth / maxConversationWidth}%` }}>
                  <div className="message-content"><div className="markdown">{t('prefs.sampleReply')}<br />{t('prefs.sampleReplyNext')}</div></div>
                  <details className="tool-block">
                    <summary><span>Read</span><span className="tool-state">{t('prefs.sampleDone')}</span></summary>
                    <div className="tool-detail"><pre>README.md</pre></div>
                  </details>
                  <div className="composer"><textarea readOnly rows={2} aria-label={t('prefs.sampleInputLabel')} value={t('prefs.sampleInput')} /></div>
                </div>
              </figure>
              <button className="pref-action" onClick={() => setDesktop(defaultChatLayout)}>{t('prefs.resetLayout')}</button>
            </>
          )}
          {tab === "preview" && <>
            <h3>{t('prefs.tabPreview')}</h3>
            <p>{t('prefs.previewHelp')}</p>
            {previewRanges.map(({ key, label, min, max, step, unit }) => (
              <label key={key}>
                {t(label)}
                <span>
                  <input type="range" aria-label={t(label)} min={min} max={max} step={step}
                    value={settings[key]} aria-valuetext={`${settings[key]}${unit}`}
                    onChange={e => setDesktop({ [key]: e.currentTarget.valueAsNumber })} />
                  <output>{settings[key]}{unit}</output>
                </span>
              </label>
            ))}
            {previewToggles.map(({ key, label }) => (
              <label key={key}>{t(label)}
                <input type="checkbox" checked={settings[key]} onChange={e => setDesktop({ [key]: e.currentTarget.checked })} />
              </label>
            ))}
            <figure className="pref-code-preview">
              <figcaption>{t('prefs.codePreview')}</figcaption>
              <CodePreview className="artifact-text" name="sample.py" highlight={settings.previewHighlight}
                lineNumbers={settings.previewLineNumbers} wrap={settings.previewWrap} text={previewSample()} />
            </figure>
            <button className="pref-action" onClick={() => setDesktop(defaultPreview)}>{t('prefs.resetPreview')}</button>
          </>}
          {tab === "history" && <>
            <h3>{t('prefs.tabHistory')}</h3>
            <label>{t('prefs.pageSize')}
              <span><input type="number" aria-label={t('prefs.pageSize')} aria-describedby="history-size-hint"
                min={MIN_HISTORY_PAGE_MIB} max={MAX_HISTORY_PAGE_MIB} step="any" required
                defaultValue={settings.historyPageMiB}
                onChange={e => { if (e.currentTarget.validity.valid) setDesktop({ historyPageMiB: e.currentTarget.valueAsNumber }); }}
                onBlur={e => { e.currentTarget.value = String(settings.historyPageMiB); }} />MiB</span>
            </label>
            <p id="history-size-hint">{t('prefs.pageSizeHelp', { min: MIN_HISTORY_PAGE_MIB, max: MAX_HISTORY_PAGE_MIB })}</p>
          </>}
          {tab === "projects" && (
            <>
              <h3>{t('prefs.tabProjects')}</h3>
              <p>{t('prefs.projectsHelp')}</p>
              {workspaceMachines(platform, settings.connections, sorted).filter(m => m.folders.length > 0).map(machine => <section key={machine.key}>
                <h4>{machine.name}</h4>
                {machine.folders.map((w, i, folders) => (
                <div key={w.id} className="pref-project">
                  <div>
                    <strong>{w.name}</strong>
                    <small>{w.cwd}</small>
                  </div>
                  <button
                    className="icon-button"
                    disabled={!i}
                    aria-label={t('prefs.moveUp', { name: w.name })}
                    onClick={() =>
                      moveProject(
                        sorted.map((w) => w.id),
                        w.id,
                        folders[i - 1].id,
                      )
                    }
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={i === folders.length - 1}
                    aria-label={t('prefs.moveDown', { name: w.name })}
                    onClick={() =>
                      moveProject(
                        sorted.map((w) => w.id),
                        w.id,
                        folders[i + 1].id,
                      )
                    }
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
              ))}</section>)}
              {!sorted.length && <p>{t('prefs.noProjects')}</p>}
            </>
          )}
          {tab === "session" && (
            <>
              <h3>{t('prefs.tabSession')}</h3>
              <label>
                {t('prefs.settingSwitch')}
                <select aria-label={t('prefs.settingSwitch')} value={settings.settingSwitch}
                  onChange={e => setDesktop({ settingSwitch: e.target.value === "menu" ? "menu" : "inline" })}>
                  <option value="inline">{t('prefs.switchInline')}</option>
                  <option value="menu">{t('prefs.switchMenu')}</option>
                </select>
              </label>
              <p>{t('prefs.switchHelp')}</p>
              <label>{t('prefs.enableWorkflows')}
                <input type="checkbox" checked={settings.enableWorkflows} onChange={e => setDesktop({ enableWorkflows: e.currentTarget.checked })} />
              </label>
              <p>{t('prefs.workflowsHelp')}</p>
              <label>
                {t('prefs.cacheTtl')}
                <select aria-label={t('prefs.cacheTtl')} aria-describedby="cache-ttl-default-help cache-ttl-help" value={settings.promptCacheTtlPreset}
                  onChange={e => setDesktop({ promptCacheTtlPreset: promptCacheTtlPreset(e.target.value) })}>
                  {promptCacheTtlPresets.map(preset => <option key={preset} value={preset}>{t(cacheTtlLabels[preset])}</option>)}
                </select>
              </label>
              <p id="cache-ttl-default-help">{t('prefs.cacheTtlDefaultHelp')}</p>
              <p id="cache-ttl-help">{t('prefs.cacheTtlHelp')}</p>
              <label>{t('conversationSettings.warn')}
                <input type="checkbox" checked={settings.warnSettingsOverrides} onChange={e => setDesktop({ warnSettingsOverrides: e.currentTarget.checked })} />
              </label>
              <label>{t('prefs.dialogHooks')}
                <input type="checkbox" aria-describedby="dialog-hooks-help" checked={settings.dialogHooks} onChange={e => setDesktop({ dialogHooks: e.currentTarget.checked })} />
              </label>
              <p id="dialog-hooks-help">{t('prefs.dialogHooksHelp')}</p>
              {hookStatus && <p className="pref-hook-status" data-hook-state={hookStatus.state} role="status">{t(hookStatusText(hookStatus))}</p>}
              <QuitPreferenceSetting resetKey={quitReset} />
              <button className="pref-action" onClick={() => {
                setDesktop(defaultSessionOptions);
                void window.desktop.setQuitPreferences(defaultQuitPreferences).catch(() => {}).finally(() => setQuitReset(n => n + 1));
              }}>{t('prefs.resetDefault')}</button>
            </>
          )}
          {tab === "trash" && <ArchivedSessions workspaces={workspaces} />}
          {tab === "updates" && <UpdateSettings />}
          {tab === "connections" && (
            <>
              <h3>{t('prefs.tabConnections')}</h3>
              <p>
                {t('prefs.sshHelp')}
              </p>
              {sshMachines(settings.connections, workspaces).map((machine) => {
                const c = machine.profile, status = connectionOf(machine.key);
                const disconnected = status?.state === "disconnected";
                const problem = disconnected ? t('prefs.sshDisconnected') : status?.state === "login" ? t('prefs.stateLogin') : status?.state === "unreachable" ? t('prefs.stateOffline') : status?.state === "unsupported" ? t('prefs.stateUnsupported') : "";
                return (
                <div key={machine.key} className="pref-project" data-ssh-machine={machine.host}>
                  <div>
                    <strong>{machine.name}{problem && <span className={`machine-connection state-${status!.state}`} title={"message" in status! ? status.message : undefined}>{problem}</span>}</strong>
                    <small>
                      {machine.host}
                      {machine.port ? " · " + machine.port : ""}
                      {machine.folders ? t('prefs.folderCount', { count: machine.folders }) : ""}
                      {!c && t('prefs.addedByFolder')}
                    </small>
                  </div>
                  <SshMachineButton machine={machine} disconnected={disconnected} available={!demo && platform !== "win32"} />
                  {!disconnected && <button
                    className="icon-button"
                    aria-label={t('prefs.loginMachine', { name: machine.name })}
                    title={t('prefs.loginThisMachine')}
                    onClick={() => openSshLogin({ host: machine.host, port: machine.port }, { label: machine.name,
                      onDone: () => setMachineConnection(machine.key, { state: "ok" }) })}
                  >
                    <LogIn size={14} />
                  </button>}
                  <button
                    className="icon-button"
                    aria-label={t('prefs.editConnectionOf', { name: machine.name })}
                    title={c ? t('prefs.editConnection') : t('prefs.saveAsConnection')}
                    onClick={() => {
                      setEditing(c ?? { id: "", name: machine.name, host: machine.host, port: machine.port });
                      setConnectionError("");
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  {c ? <button
                    className="icon-button"
                    aria-label={t('prefs.removeConnectionOf', { name: machine.name })}
                    title={machine.folders ? t('prefs.removeKeepsFolders') : t('prefs.removeConnection')}
                    onClick={() => {
                      setDesktop({
                        connections: settings.connections.filter(
                          (x) => x.id !== c.id,
                        ),
                      });
                      if (editing?.id === c.id) setEditing(undefined);
                    }}
                  >
                    <Trash2 size={14} />
                  </button> : <span className="pref-icon-spacer" aria-hidden="true" />}
                </div>
              ); })}
              {editing ? (
                <form
                  key={editing.id}
                  className="pref-connection-form"
                  onSubmit={submitConnection}
                >
                  <label>
                    {t('prefs.connectionName')}
                    <input
                      name="name"
                      placeholder={t('prefs.connectionNameExample')}
                      defaultValue={editing.name}
                      maxLength={100}
                    />
                  </label>
                  <label>
                    {t('prefs.sshHost')}
                    <input
                      required
                      name="host"
                      placeholder={t('prefs.sshHostExample')}
                      defaultValue={editing.host}
                      maxLength={255}
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    {t('prefs.port')}
                    <input
                      name="port"
                      placeholder={t('prefs.portDefault')}
                      defaultValue={editing.port}
                      inputMode="numeric"
                    />
                  </label>
                  {connectionError && <p role="alert">{connectionError}</p>}
                  <div className="pref-actions">
                    {!editing.id && (
                      <button type="button" className="pref-action pref-import-link" onClick={() => setImportingSsh(true)}>
                        <FileInput size={15} />
                        {t('prefs.importSshConfig')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="pref-action"
                      onClick={() => setEditing(undefined)}
                    >
                      {t('prefs.cancel')}
                    </button>
                    <button className="pref-action primary" type="submit">
                      <Check size={15} />
                      {t('prefs.saveConnection')}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="pref-actions pref-connection-actions">
                  <button
                    className="pref-action"
                    onClick={() => {
                      setEditing({ id: "", name: "", host: "" });
                      setConnectionError("");
                    }}
                  >
                    <Plus size={15} />
                    {t('prefs.addConnection')}
                  </button>
                  <button className="pref-action" onClick={() => setImportingSsh(true)}>
                    <FileInput size={15} />
                    {t('prefs.importSshConfig')}
                  </button>
                </div>
              )}
              <SshConnectionSetting platform={platform} />
            </>
          )}
        </section>
      </div>
      {importingSsh && (
        <SshConfigImportDialog
          onClose={() => setImportingSsh(false)}
          onImported={count => {
            if (!count) return;
            setEditing(undefined);
            setConnectionError("");
            if (newMachine) onClose();
          }}
        />
      )}
    </dialog>
  );
}

function SshMachineButton({ machine, disconnected, available }: { machine: SshMachine; disconnected: boolean; available: boolean }) {
  const { host, port, name } = machine;
  const [master, setMaster] = useState<SshMasterState>("none");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMaster("none");
    if (disconnected || !available) return;
    let live = true;
    const check = () => { void window.desktop.sshMasterState({ host, port }).then(state => { if (live) setMaster(state); }).catch(() => {}); };
    check();
    const timer = setInterval(check, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [host, port, disconnected, available]);
  const connect = disconnected || master === "disconnected";
  return <button className="secondary-button pref-ssh-machine-button" type="button"
    disabled={busy || !available || (!connect && master !== "private")}
    title={connect ? undefined : sshDisconnectHint(master)}
    aria-label={t(connect ? 'prefs.sshConnectMachine' : 'prefs.sshDisconnectMachine', { name })}
    onClick={async () => {
      setBusy(true);
      try {
        if (connect) await connectSshMachine({ host, port }, name);
        else {
          await disconnectSshMachine({ host, port }, name);
          setMaster(await window.desktop.sshMasterState({ host, port }));
        }
      } catch (error) {
        reportActionError(error, 'SSH connection action');
        showToast(error instanceof Error ? error.message : String(error));
      }
      finally { setBusy(false); }
    }}>{t(connect ? 'prefs.sshConnect' : 'prefs.sshDisconnect')}</button>;
}

/** Conversations archived from the sidebar, grouped by folder. Their files on the
 * target machine were never touched; restoring only lists them again. */
function ArchivedSessions({ workspaces }: { workspaces: Workspace[] }) {
  const { archivedSessions } = useDesktopState();
  const groups = workspaces.map(w => ({ workspace: w, items: archivedSessions.filter(a => a.workspaceId === w.id) })).filter(g => g.items.length);
  const time = (value: string) => dateTimeText(value, { hour12: false });
  return <>
    <h3>{t('prefs.tabTrash')}</h3>
    <p>{t('prefs.trashHelp')}</p>
    {!groups.length && <p className="pref-empty" data-trash-empty>{t('prefs.trashEmpty')}</p>}
    {groups.map(({ workspace, items }) => <section key={workspace.id} className="pref-trash-group" aria-label={workspace.name}>
      <h4>{workspace.name}<small>{workspace.kind === "ssh" ? `${workspace.host}:` : ""}{workspace.cwd}</small></h4>
      {[...items].reverse().map(item => <div key={item.sessionId} className="pref-project" data-archived-session={item.sessionId}>
        <div><strong>{item.title}</strong><small>{item.sessionId.slice(0, 8)} · {t('prefs.archivedAt', { time: time(item.archivedAt) })}</small></div>
        <button className="pref-action" aria-label={t('prefs.restoreItem', { title: item.title })} onClick={() => restoreSessions([archiveKey(item.workspaceId, item.sessionId)])}>
          <ArchiveRestore size={14} />{t('prefs.restore')}
        </button>
      </div>)}
    </section>)}
    {groups.length > 0 && <button className="pref-action" onClick={() => restoreSessions(archivedSessions.map(a => archiveKey(a.workspaceId, a.sessionId)))}>{t('prefs.restoreAll')}</button>}
  </>;
}
