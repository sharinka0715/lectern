import { useDesktopState } from "./desktop-state";
import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Laptop, Server, X } from "lucide-react";
import type { HostKind, Workspace, WorkspaceEndpoint } from "../shared/types";
import { WorkspaceDirectoryPicker } from "./WorkspaceDirectoryPicker";
import type { WorkspaceMachine } from "./workspace-machines";
import { reportActionError } from "./diagnostics";
import { sshOnly } from "../shared/supported-targets";
import { sshMachines } from "./ssh-machines";
import { t } from '../shared/i18n';

export function WorkspaceDialog({
  workspace,
  platform,
  onClose,
  onSave,
  onRemove,
  machine,
  workspaces = [],
}: {
  machine?: WorkspaceMachine;
  workspace?: Workspace;
  /** Folders already added: their SSH machines are offered with the saved connections. */
  workspaces?: Workspace[];
  platform: string;
  onClose(): void;
  onSave(workspace: Workspace): Promise<void>;
  onRemove?(id: string): Promise<void>;
}) {
  const { connections } = useDesktopState();
  const knownMachines = sshMachines(connections, workspaces);
  const cwdInputId = useId();
  const endpoint = workspace ?? machine?.endpoint;
  const [kind, setKind] = useState<HostKind>(
    endpoint?.kind || (sshOnly(platform) ? "ssh" : "local"),
  );
  const [name, setName] = useState(workspace?.name || "");
  const [cwd, setCwd] = useState(workspace?.cwd || "");
  const [pickedPath, setPickedPath] = useState(workspace?.cwd);
  const [picker, setPicker] = useState<WorkspaceEndpoint>();
  const projectPath = cwd === pickedPath ? cwd : cwd.trim();
  const folderName = projectPath.split('/').filter(Boolean).at(-1) || (projectPath.startsWith('/') ? '/' : '');
  const [host, setHost] = useState(endpoint?.host || "");
  const [port, setPort] = useState(String(endpoint?.port || ""));
  const [claudeDir, setClaudeDir] = useState(workspace?.claudeDir || "");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function connection(): WorkspaceEndpoint | undefined {
    if (kind === 'ssh' && !host.trim()) {
      setError(t('dialogs.hostRequired'));
      return;
    }
    if (
      kind === "ssh" &&
      port &&
      (!/^\d+$/.test(port) || +port < 1 || +port > 65535)
    ) {
      setError(t('dialogs.invalidPort'));
      return;
    }
    if (kind === 'ssh') return {kind, host:host.trim(), ...(port && {port:Number(port)})};
    return {kind};
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const target = connection();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    try {
      let path = projectPath;
      let defaultName = folderName;
      if (!name.trim() && (path.replace(/\/+$/, '') === '~' || folderName === '.' || folderName === '..')) {
        path = (await window.desktop.listWorkspaceDirectories(target, path)).path;
        defaultName = path.split('/').at(-1) || '/';
      }
      await onSave({
        ...target,
        id: workspace?.id || crypto.randomUUID(),
        name: name === defaultName ? defaultName : name.trim() || defaultName,
        cwd: path,
        ...(claudeDir.trim() ? { claudeDir: claudeDir.trim() } : {}),
        // A new folder starts without scanning its saved conversations; editing keeps the choice.
        ...(workspace ? workspace.historyScan === false && { historyScan: false as const } : { historyScan: false as const }),
      });
      onClose();
    } catch (e) {
      reportActionError(e, "保存工作目录失败");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function browse() {
    const target = connection();
    if (!target) return;
    setError('');
    setPicker(target);
  }
  return (
    <dialog
      className="modal workspace-modal"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="workspace-dialog-title"
    >
      <form onSubmit={submit}>
        <div className="modal-header">
          <div>

            <h2 id="workspace-dialog-title">
              {t(workspace ? 'dialogs.editFolder' : machine ? 'dialogs.addProjectFolder' : 'dialogs.connectFolder')}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={t('dialogs.close')}
          >
            <X size={19} />
          </button>
        </div>
        <p className="modal-description">
          {t('dialogs.folderOnly')}
        </p>
        {/* Windows reaches SSH machines only: no local option to switch to. */}
        {machine ? <div className="machine-endpoint">{kind === "ssh" ? <Server size={16}/> : <Laptop size={16}/>}{machine.name}</div> : sshOnly(platform) ? null : <div className="segmented" role="group" aria-label={t('dialogs.connectionType')}>
          <button
            type="button"
            className={kind !== "ssh" ? "selected" : ""}
            onClick={() => setKind("local")}
          >
            <Laptop size={16} />
            {t('dialogs.local')}
          </button>
          <button
            type="button"
            className={kind === "ssh" ? "selected" : ""}
            onClick={() => setKind("ssh")}
          >
            <Server size={16} />
            {t('dialogs.remoteSsh')}
          </button>
        </div>}
        <label className="field-label">
          {t('dialogs.name')}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={folderName && !['~', '.', '..'].includes(folderName) ? folderName : t('dialogs.useFolderName')}
            maxLength={120}
          />
        </label>
        {kind === "ssh" && !machine && (
          <>
            {!!knownMachines.length && <label className="field-label">{t('dialogs.savedConnections')}
              <select aria-label={t('dialogs.savedConnections')} value={knownMachines.find(c => c.host === host && String(c.port || "") === port)?.key ?? ""}
                onChange={e => { const c = knownMachines.find(c => c.key === e.target.value); if(c) {setHost(c.host);setPort(String(c.port || ""));} else { setHost(""); setPort(""); } }}>
                <option value="">{t('dialogs.customConnection')}</option>{knownMachines.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
              </select></label>}
            <div className="field-row">
              <label className="field-label grow">
                {t('dialogs.sshHost')}
                <input
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={t('dialogs.sshHostExample')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field-label port-field">
                {t('dialogs.port')}
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={t('dialogs.configDefault')}
                  inputMode="numeric"
                />
              </label>
            </div>
          </>
        )}
        <div className="field-label">
          <label htmlFor={cwdInputId}>{t('dialogs.folder')}</label>
          <div className="input-with-button">
            <input
              id={cwdInputId}
              required
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={
                kind === "local" && platform === "darwin"
                  ? "/Users/you/projects/my-app"
                  : "/home/user/projects/my-app"
              }
              spellCheck={false}
            />
            <button type="button" onClick={browse} disabled={busy} title={t('dialogs.chooseFolder')} aria-label={t('dialogs.chooseFolder')}>
              <FolderOpen size={18} />
            </button>
          </div>
        </div>
        {kind === "ssh" && (
          <p className="field-hint">
            {t('dialogs.sshHint')}
          </p>
        )}
        <details className="advanced-options">
          <summary>{t('dialogs.advanced')}</summary>
          <label className="field-label">
            {t('dialogs.claudeConfigDir')}
            <input
              value={claudeDir}
              onChange={(e) => setClaudeDir(e.target.value)}
              placeholder={t('dialogs.inheritTarget')}
              spellCheck={false}
            />
          </label>
          <p className="field-hint">
            {t('dialogs.configHelp')}
          </p>
        </details>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          {workspace && onRemove && (
            <button
              className="text-button danger"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                setBusy(true);
                try {
                  await onRemove(workspace.id);
                  onClose();
                } catch (e) {
                  reportActionError(e, "移除工作目录失败");
                  setError(String(e));
                  setBusy(false);
                }
              }}
            >
              {t(confirmRemove ? 'dialogs.confirmRemove' : 'dialogs.removeFolder')}
            </button>
          )}
          <div className="spacer" />
          <button className="secondary-button" type="button" onClick={onClose}>
            {t('dialogs.cancel')}
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {t(busy ? 'dialogs.saving' : workspace ? 'dialogs.saveChanges' : 'dialogs.addFolder')}
          </button>
        </div>
      </form>
      {picker && <WorkspaceDirectoryPicker target={picker} initialPath={projectPath} onClose={() => setPicker(undefined)}
        onSelect={path => { setCwd(path); setPickedPath(path); setPicker(undefined); }} />}
    </dialog>
  );
}
