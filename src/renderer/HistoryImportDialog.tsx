import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Folder, History, Loader2, RefreshCw, X } from "lucide-react";
import type {
  HistoryProject,
  HistoryScan,
  HistoryTarget,
  Workspace,
} from "../shared/types";
import { findImportedWorkspace } from "./history-import";
import { reportActionError } from "./diagnostics";
import { localeTag, t } from '../shared/i18n';

function timestampLabel(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(+parsed)
    ? ""
    : parsed.toLocaleDateString(localeTag(), {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
}

export function HistoryImportDialog({
  workspaces,
  onClose,
  onImport,
  onView,
}: {
  workspaces: Workspace[];
  onClose(): void;
  onImport(
    target: HistoryTarget,
    projects: HistoryProject[],
    resolvedClaudeDir: string,
  ): Promise<void>;
  onView(workspace: Workspace): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const currentWorkspaces = useRef(workspaces);
  currentWorkspaces.current = workspaces;
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<HistoryScan>();
  const [scannedTarget, setScannedTarget] = useState<HistoryTarget>();
  const [chosen, setChosen] = useState(new Set<string>());
  const [claudeDir, setClaudeDir] = useState("");
  const scanProjects = useCallback(async (target: HistoryTarget) => {
    const generation = ++request.current;
    setLoading(true);
    setError("");
    setScan(undefined);
    setScannedTarget(undefined);
    setChosen(new Set());
    try {
      const result = await window.desktop.discoverHistoryProjects(target);
      if (generation !== request.current) return;
      setScan(result);
      setScannedTarget(target);
      setChosen(
        new Set(
          result.projects
            .filter(
              (project) =>
                project.exists &&
                !findImportedWorkspace(
                  currentWorkspaces.current,
                  target,
                  project.cwd,
                  result.claudeDir,
                ),
            )
            .map((project) => project.cwd),
        ),
      );
    } catch (e) {
      reportActionError(e, "发现历史会话失败");
      if (generation === request.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    dialog.current?.showModal();
    void scanProjects({ kind: "local" });
    return () => {
      ++request.current;
    };
  }, [scanProjects]);

  const importedWorkspace = (project: HistoryProject) =>
    scannedTarget &&
    findImportedWorkspace(
      workspaces,
      scannedTarget,
      project.cwd,
      scan?.claudeDir,
    );
  const eligible =
    scan?.projects.filter(
      (project) => project.exists && !importedWorkspace(project),
    ) ?? [];
  const selection = eligible.filter((project) => chosen.has(project.cwd));
  const importedCount =
    scan?.projects.filter((project) => importedWorkspace(project)).length ?? 0;
  const missingCount =
    scan?.projects.filter((project) => !project.exists).length ?? 0;

  function rescan() {
    void scanProjects({
      kind: "local",
      ...(claudeDir.trim() ? { claudeDir: claudeDir.trim() } : {}),
    });
  }
  async function importSelected() {
    if (!scan || !scannedTarget || !selection.length) return;
    setImporting(true);
    setError("");
    try {
      await onImport(scannedTarget, selection, scan.claudeDir);
      onClose();
    } catch (e) {
      reportActionError(e, "添加历史工作目录失败");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }
  function toggle(cwd: string) {
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        if (importing) event.preventDefault();
        else onClose();
      }}
      className="modal history-import-modal"
      aria-labelledby="history-import-title"
    >
      <div className="modal-header">
        <div>

          <h2 id="history-import-title">
            {t('dialogs.discoverTitle')}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label={t('dialogs.closeDiscover')}
          onClick={onClose}
          disabled={importing}
        >
          <X size={19} />
        </button>
      </div>
      <p className="modal-description">
        {t('dialogs.discoverIntro')}
      </p>
      <details className="history-scan-options">
        <summary>{t('dialogs.scanSettings')}</summary>
        <div className="history-scan-fields">
          <label className="field-label">
            {t('dialogs.claudeConfigDir')}
            <input
              value={claudeDir}
              onChange={(event) => setClaudeDir(event.target.value)}
              placeholder={t('dialogs.inheritTarget')}
              spellCheck={false}
              disabled={loading || importing}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            aria-label={t('dialogs.rescanLabel')}
            onClick={rescan}
            disabled={loading || importing}
          >
            <RefreshCw size={14} />
            {t('dialogs.rescan')}
          </button>
        </div>
      </details>
      {loading ? (
        <div className="history-scan-loading" role="status">
          <Loader2 className="rotating" size={20} />
          <strong>{t('dialogs.scanning')}</strong>
          <span>{t('dialogs.readOnlyScan')}</span>
        </div>
      ) : (
        scan && (
          <>
            <div className="history-scan-summary">
              <span>
                {t('dialogs.scanSummary', { folders: scan.projects.length,
                  sessions: scan.projects.reduce((count, project) => count + project.sessionCount, 0) })}
              </span>
              {eligible.length > 0 && (
                <button
                  className="text-button"
                  onClick={() =>
                    setChosen(
                      selection.length === eligible.length
                        ? new Set()
                        : new Set(eligible.map((project) => project.cwd)),
                    )
                  }
                  disabled={importing}
                >
                  {selection.length === eligible.length
                    ? t('dialogs.deselectAll')
                    : t('dialogs.selectAll')}
                </button>
              )}
            </div>
            <div
              className="history-project-list"
              aria-label={t('dialogs.foundFolders')}
            >
              {scan.projects.map((project) => {
                const existing = importedWorkspace(project);
                return (
                  <div
                    className={`history-project-row${!project.exists ? " history-project-missing" : ""}`}
                    key={project.cwd}
                    data-cwd={project.cwd}
                    data-exists={project.exists}
                    data-imported={!!existing}
                  >
                    <input
                      type="checkbox"
                      aria-label={t('dialogs.selectFolder', { path: project.cwd })}
                      checked={
                        !existing && chosen.has(project.cwd) && project.exists
                      }
                      disabled={importing || !project.exists || !!existing}
                      onChange={() => toggle(project.cwd)}
                    />
                    <Folder size={17} />
                    <div className="history-project-description">
                      <strong title={project.cwd}>{project.cwd}</strong>
                      <span>
                        {t('dialogs.sessionCount', { count: project.sessionCount })}
                        {project.latestAt
                          ? ` · ${timestampLabel(project.latestAt)}`
                          : ""}
                        {!project.exists
                          ? t('dialogs.folderGone')
                          : existing
                            ? t('dialogs.alreadyAdded')
                            : ""}
                      </span>
                    </div>
                    {existing && project.exists ? (
                      <button
                        className="text-button"
                        onClick={() => {
                          onView(existing);
                          onClose();
                        }}
                        disabled={importing}
                      >
                        {t('dialogs.view')}
                      </button>
                    ) : existing ? (
                      <Check className="history-imported-check" size={15} />
                    ) : null}
                  </div>
                );
              })}
            </div>
            {!scan.projects.length && (
              <div className="history-scan-empty">
                <History size={23} />
                <strong>{t('dialogs.nothingFound')}</strong>
                <p>{t('dialogs.nothingFoundHelp')}</p>
              </div>
            )}
            {missingCount > 0 && (
              <p className="field-hint history-missing-hint">
                {t('dialogs.missingFolders', { count: missingCount })}
              </p>
            )}
            {importedCount > 0 && (
              <p className="field-hint">
                {t('dialogs.alreadyInSidebar', { count: importedCount })}
              </p>
            )}
            <div className="history-scan-metadata">
              <span>
                {t('dialogs.scannedFiles', { count: scan.scannedFiles })}
                {scan.skippedFiles
                  ? t('dialogs.skippedRecords', { count: scan.skippedFiles })
                  : ""}
              </span>
              <code title={scan.claudeDir}>{scan.claudeDir}</code>
            </div>
            {scan.truncated && (
              <div className="notice-banner history-scan-notice">
                {t('dialogs.scanTruncated')}
              </div>
            )}
            {scan.diagnostic && (
              <div className="notice-banner history-scan-notice">
                {scan.diagnostic}
              </div>
            )}
          </>
        )
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={rescan}
            disabled={loading || importing}
          >
            {t('dialogs.rescan')}
          </button>
        </div>
      )}
      <div className="modal-footer">
        <span className="history-import-footer-note">
          {t('dialogs.jsonlKept')}
        </span>
        <div className="spacer" />
        <button
          className="secondary-button"
          onClick={onClose}
          disabled={importing}
        >
          {t('dialogs.close')}
        </button>
        <button
          className="primary-button"
          aria-label={t('dialogs.addSelected')}
          onClick={() => void importSelected()}
          disabled={loading || importing || !selection.length}
        >
          {importing ? (
            <>
              <Loader2 size={14} className="rotating" />
              {t('dialogs.adding')}
            </>
          ) : (
            t('dialogs.addCount', { count: selection.length })
          )}
        </button>
      </div>
    </dialog>
  );
}
