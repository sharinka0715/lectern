import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FolderOpen, Loader2, RefreshCw, X } from "lucide-react";
import type { DiagnosticsInfo } from "../shared/types";
import { reportActionError } from "./diagnostics";
import { formatNumber, t } from '../shared/i18n';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function DiagnosticsPanel({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<DiagnosticsInfo>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [incident, setIncident] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const refreshing = useRef(false);
  const infoRevision = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const request = infoRevision.current;
    try {
      const result = await window.desktop.diagnosticsInfo();
      if (mounted.current && request === infoRevision.current) setInfo(result);
    } catch (e) {
      reportActionError(e, "读取诊断状态");
      if (mounted.current) setError(errorMessage(e));
    } finally {
      refreshing.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  async function toggle(enabled: boolean) {
    ++infoRevision.current;
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.setDiagnosticContent(enabled);
      ++infoRevision.current;
      setInfo(result);
    } catch (e) {
      reportActionError(e, "更改诊断原文记录");
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function mark(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setIncident(await window.desktop.markDiagnosticIncident(note));
      await refresh();
    } catch (e) {
      reportActionError(e, "标记诊断问题");
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function openFolder() {
    try {
      await window.desktop.openDiagnosticsDirectory();
    } catch (e) {
      reportActionError(e, "打开诊断日志目录");
      setError(errorMessage(e));
    }
  }
  async function copyIncident() {
    try {
      await window.desktop.copyText(incident);
      setCopied(true);
    } catch (e) {
      reportActionError(e, t('misc.copyIncidentId'));
      setError(errorMessage(e));
    }
  }

  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      className="modal diagnostics-modal"
      aria-labelledby="diagnostics-title"
    >
      <div className="modal-header">
        <div>

          <h2 id="diagnostics-title">{t('misc.diagnosticsTitle')}</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={t('misc.closeDiagnostics')}
        >
          <X size={19} />
        </button>
      </div>
      <p className="modal-description">
        {t('misc.diagnosticsIntro')}
      </p>
      {!info ? (
        <div className="diagnostics-loading">
          <Loader2 size={16} className="rotating" />
          {t('misc.readingLogState')}
        </div>
      ) : (
        <>
          <div className="diagnostics-toggle">
            <div>
              <strong>{t('misc.captureContent')}</strong>
              <p>{t('misc.captureHelp')}</p>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('misc.captureContent')}
              checked={info.captureContent}
              disabled={busy || !info.enabled}
              onChange={(event) => void toggle(event.target.checked)}
            />
          </div>
          <dl className="diagnostics-details">
            <div>
              <dt>{t('misc.state')}</dt>
              <dd>
                {t(info.enabled
                  ? info.captureContent
                    ? 'misc.onWithContent'
                    : 'misc.onMetadata'
                  : 'misc.off')}
              </dd>
            </div>
            <div>
              <dt>{t('misc.logFolder')}</dt>
              <dd>
                <code className="diagnostics-path">{info.directory}</code>
              </dd>
            </div>
            <div>
              <dt>{t('misc.thisRun')}</dt>
              <dd>
                <code>{info.runId}</code>
              </dd>
            </div>
            <div>
              <dt>{t('misc.rollingLimit')}</dt>
              <dd>
                {t('misc.limitValue', { size: formatNumber(info.maxFileBytes / 1024 / 1024, { maximumFractionDigits: 1 }), count: info.maxFiles })}
              </dd>
            </div>
            <div>
              <dt>{t('misc.droppedEvents')}</dt>
              <dd className={info.droppedEvents ? "diagnostic-warning" : ""}>
                {info.droppedEvents}
                {info.droppedEvents > 0 ? t('misc.someDropped') : ""}
              </dd>
            </div>
          </dl>
          {info.lastError && (
            <div className="form-error" role="alert">
              {t('misc.lastWriteError', { error: info.lastError })}
            </div>
          )}
          <div className="diagnostics-actions">
            <button
              className="secondary-button"
              onClick={() => void openFolder()}
            >
              <FolderOpen size={14} />
              {t('misc.openLogFolder')}
            </button>
            <button
              className="icon-button"
              onClick={() => {
                setError("");
                void refresh();
              }}
              aria-label={t('misc.refreshState')}
              title={t('misc.refreshState')}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <form
            className="diagnostics-incident"
            onSubmit={(event) => void mark(event)}
          >
            <label className="field-label" htmlFor="diagnostic-note">
              {t('misc.markIncident')}
              <input
                id="diagnostic-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={240}
                placeholder={t('misc.incidentPlaceholder')}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !info.enabled}
            >
              {busy ? <Loader2 className="rotating" size={14} /> : null}
              {t('misc.markTime')}
            </button>
            {incident && (
              <div className="incident-result" role="status">
                <span>
                  {t('misc.incidentId')}<code>{incident}</code>
                </span>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void copyIncident()}
                  aria-label={t('misc.copyIncidentId')}
                  title={t('misc.copyIncidentId')}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
            )}
          </form>
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-footer">
        <div className="spacer" />
        <button className="secondary-button" onClick={onClose}>
          {t('misc.close')}
        </button>
      </div>
    </dialog>
  );
}
