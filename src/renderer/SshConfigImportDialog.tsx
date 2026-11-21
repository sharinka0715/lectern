import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSearch, Loader2, RefreshCw, Server, X } from "lucide-react";
import { describeSshHost, type SshConfigImport } from "../shared/ssh-config";
import { setDesktop, useDesktopState } from "./desktop-state";
import { reportActionError } from "./diagnostics";
import { filterSshImportRows, importSshConnections, sshImportRows } from "./ssh-config-import";
import { t } from '../shared/i18n';

/** Pick Host aliases from this computer's ~/.ssh/config and save them as SSH machines. */
export function SshConfigImportDialog({ onClose, onImported }: { onClose(): void; onImported?(count: number): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settings = useDesktopState();
  const [config, setConfig] = useState<SshConfigImport>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(new Set<string>());
  async function load() {
    setLoading(true); setError("");
    try { setConfig(await window.desktop.listSshConfigHosts()); setChosen(new Set()); }
    catch (e) { reportActionError(e, "读取 SSH 配置失败"); setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { dialog.current?.showModal(); void load(); }, []);
  const rows = useMemo(() => sshImportRows(config?.hosts ?? [], settings.connections), [config, settings.connections]);
  const visible = filterSshImportRows(rows, query);
  const selectable = visible.filter(row => row.status === "available");
  const selected = rows.filter(row => row.status === "available" && chosen.has(row.host.alias));
  const allVisibleChosen = selectable.length > 0 && selectable.every(row => chosen.has(row.host.alias));
  function toggle(alias: string) {
    setChosen(previous => { const next = new Set(previous); if (next.has(alias)) next.delete(alias); else next.add(alias); return next; });
  }
  function toggleVisible() {
    setChosen(previous => {
      const next = new Set(previous);
      for (const row of selectable) if (allVisibleChosen) next.delete(row.host.alias); else next.add(row.host.alias);
      return next;
    });
  }
  function importSelected() {
    const connections = importSshConnections(chosen, rows, settings.connections);
    setDesktop({ connections });
    onImported?.(connections.length - settings.connections.length);
    onClose();
  }
  return (
    <dialog ref={dialog} className="modal history-import-modal ssh-import-modal" aria-labelledby="ssh-import-title" onCancel={onClose}>
      <div className="modal-header">
        <h2 id="ssh-import-title">{t('dialogs.sshImportTitle')}</h2>
        <button className="icon-button" aria-label={t('dialogs.closeSshImport')} onClick={onClose}><X size={19} /></button>
      </div>
      <p className="modal-description">
        {t('dialogs.sshImportIntro')}
      </p>
      {loading ? (
        <div className="history-scan-loading" role="status"><Loader2 className="rotating" size={20} /><strong>{t('dialogs.readingSshConfig')}</strong></div>
      ) : config && (
        <>
          <div className="history-scan-summary">
            <input className="ssh-import-filter" type="search" value={query} placeholder={t('dialogs.filterHosts')} aria-label={t('dialogs.filterHosts')}
              spellCheck={false} onChange={event => setQuery(event.target.value)} />
            <span>{t('dialogs.hostCount', { count: rows.length })}</span>
            {selectable.length > 0 && (
              <button className="text-button" onClick={toggleVisible}>{t(allVisibleChosen ? 'dialogs.deselectAll' : 'dialogs.selectAllImportable')}</button>
            )}
          </div>
          <div className="history-project-list" aria-label={t('dialogs.configHosts')}>
            {visible.map(({ host, status }) => (
              <label className="history-project-row" key={host.alias} data-ssh-alias={host.alias} data-status={status}>
                <input type="checkbox" aria-label={t('dialogs.selectHost', { alias: host.alias })} disabled={status !== "available"}
                  checked={status === "available" && chosen.has(host.alias)} onChange={() => toggle(host.alias)} />
                <Server size={17} />
                <div className="history-project-description">
                  <strong title={host.alias}>{host.alias}</strong>
                  <span>
                    {describeSshHost(host) || t('dialogs.defaultAddress')}
                    {status === "saved" ? t('dialogs.alreadyAdded') : status === "unsupported" ? t('dialogs.unsupportedName') : ""}
                  </span>
                </div>
                {status === "saved" && <Check className="history-imported-check" size={15} />}
              </label>
            ))}
          </div>
          {!rows.length && (
            <div className="history-scan-empty">
              <FileSearch size={23} />
              <strong>{t(config.missing ? 'dialogs.noConfigFile' : 'dialogs.noImportableHosts')}</strong>
              <p>{t('dialogs.wildcardNote')}</p>
            </div>
          )}
          {config.warnings.map(warning => <p className="field-hint" key={warning}>{warning}</p>)}
          <div className="history-scan-metadata"><span>{t('dialogs.configFile')}</span><code title={config.path}>{config.path}</code></div>
        </>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-footer">
        <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />{t('dialogs.reread')}</button>
        <div className="spacer" />
        <button className="secondary-button" onClick={onClose}>{t('dialogs.cancel')}</button>
        <button className="primary-button" aria-label={t('dialogs.importSelected')} onClick={importSelected} disabled={loading || !selected.length}>
          {t('dialogs.importCount', { count: selected.length })}
        </button>
      </div>
    </dialog>
  );
}
