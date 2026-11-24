import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, ChevronRight, Folder, FolderPlus, House, Laptop, Server, X } from 'lucide-react';
import type { WorkspaceDirectoryPage, WorkspaceEndpoint } from '../shared/types';
import './workspace-directory-picker.css';
import { needsSshLogin, openSshLogin } from './ssh-login';
import { t } from '../shared/i18n';

interface Props {
  target: WorkspaceEndpoint;
  initialPath: string;
  onSelect(path: string): void;
  onClose(): void;
}

function pickerError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function WorkspaceDirectoryPicker({ target, initialPath, onSelect, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [address, setAddress] = useState(initialPath || '~');
  const [page, setPage] = useState<WorkspaceDirectoryPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const host = target.kind === 'ssh' ? `${target.host}${target.port ? `:${target.port}` : ''}` : t('files.thisComputer');

  const openDirectory = useCallback(async (path: string, offset?: number) => {
    const id = ++request.current;
    setAddress(path);
    setLoading(true);
    setError('');
    if (offset === undefined) {
      setPage(undefined);
      list.current?.scrollTo(0, 0);
    }
    try {
      const next = await window.desktop.listWorkspaceDirectories(target, path, offset);
      if (request.current !== id) return;
      setPage(previous => offset !== undefined && previous?.path === next.path
        ? { ...next, directories: [...new Set([...previous.directories, ...next.directories])] } : next);
      setAddress(next.path);
    } catch (cause) {
      if (request.current !== id) return;
      setError(pickerError(cause));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, [target]);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);
  useEffect(() => {
    void openDirectory(initialPath || '~');
    return () => { request.current++; };
  }, [initialPath, openDirectory]);

  const current = page?.path;
  const parent = current && current !== '/' ? current.slice(0, current.lastIndexOf('/')) || '/' : undefined;
  const canSelect = !loading && current !== undefined && address === current;
  const editing = folderName !== undefined;

  function cancelCreate() {
    setFolderName(undefined);
    setCreateError('');
  }

  async function createFolder(event: React.FormEvent) {
    event.preventDefault();
    if (!canSelect || !folderName?.trim() || creating) return;
    const id = ++request.current;
    setCreating(true);
    setCreateError('');
    try {
      const path = await window.desktop.createWorkspaceDirectory(target, current, folderName);
      if (request.current === id) onSelect(path);
    } catch (cause) {
      if (request.current === id) setCreateError(pickerError(cause));
    } finally {
      if (request.current === id) setCreating(false);
    }
  }

  return <dialog ref={dialog} className="modal directory-picker" aria-labelledby="directory-picker-title"
    onCancel={event => {
      event.preventDefault();
      event.stopPropagation();
      if (creating) return;
      if (editing) cancelCreate();
      else onClose();
    }}>
    <div className="modal-header">
      <div><h2 id="directory-picker-title">{t('files.chooseFolder')}</h2>
        <div className="directory-picker-host">{target.kind === 'ssh' ? <Server size={14}/> : <Laptop size={14}/>} {host}</div>
      </div>
      <button type="button" className="icon-button" disabled={creating} onClick={onClose} aria-label={t('files.closePicker')}><X size={18}/></button>
    </div>
    <form className="directory-picker-navigation" onSubmit={event => { event.preventDefault(); if (!loading && !editing) void openDirectory(address || '~'); }}>
      <button type="button" className="icon-button" title={t('files.home')} aria-label={t('files.home')} disabled={editing} onClick={() => void openDirectory('~')}><House size={17}/></button>
      <button type="button" className="icon-button" title={t('files.parent')} aria-label={t('files.parent')} disabled={!parent || editing} onClick={() => parent && void openDirectory(parent)}><ArrowUp size={17}/></button>
      <input aria-label={t('files.pathLabel')} value={address} onChange={e => setAddress(e.target.value)} readOnly={loading || editing} autoComplete="off" spellCheck={false}/>
      <button type="submit" className="icon-button" title={t('files.go')} aria-label={t('files.go')} disabled={loading || editing}><ArrowRight size={17}/></button>
    </form>
    <div ref={list} className="directory-picker-list" aria-label={t('files.subfolders')} role="region" aria-busy={loading}>
      {page?.directories.map(name => <button key={name} type="button" className="directory-picker-row" disabled={editing}
        onClick={() => void openDirectory(`${page.path.replace(/\/$/, '')}/${name}`)}>
        <Folder size={17} aria-hidden="true"/><span>{name}</span><ChevronRight size={15} aria-hidden="true"/>
      </button>)}
      {loading && <p role="status">{t('files.readingFolder')}</p>}
      {error && <p className="directory-picker-error" role="alert">{error}</p>}
      {error && target.kind === 'ssh' && target.host && needsSshLogin(error) && <button type="button" className="secondary-button directory-picker-login" disabled={editing}
        onClick={() => openSshLogin({ host: target.host!, port: target.port }, { onDone: () => void openDirectory(address || '~') })}>{t('files.loginRetry')}</button>}
      {!loading && page?.directories.length === 0 && <p>{t('files.noSubfolders')}</p>}
      {!loading && page?.nextOffset !== undefined && <button type="button" className="text-button" disabled={editing} onClick={() => void openDirectory(page.path, page.nextOffset)}>{t('files.moreFolders')}</button>}
    </div>
    {editing ? <form className="directory-picker-create" onSubmit={createFolder} aria-busy={creating}>
      <label className="field-label">{t('files.folderName')}
        <input autoFocus value={folderName} disabled={creating} onChange={e => setFolderName(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {createError && <p className="form-error" role="alert">{createError}</p>}
      <div className="modal-footer"><div className="spacer"/>
        <button type="button" className="secondary-button" disabled={creating} onClick={cancelCreate}>{t('files.cancel')}</button>
        <button type="submit" className="primary-button" disabled={!folderName.trim() || creating}>
          {t(creating ? 'files.creatingFolder' : 'files.createAndSelectFolder')}
        </button>
      </div>
    </form> : <div className="modal-footer">
      <button type="button" className="secondary-button" disabled={!canSelect} onClick={() => setFolderName('')}>
        <FolderPlus size={16} aria-hidden="true"/>{t('files.newFolder')}
      </button>
      <div className="spacer"/>
      <button type="button" className="secondary-button" onClick={onClose}>{t('files.cancel')}</button>
      <button type="button" className="primary-button" disabled={!canSelect} onClick={() => current && onSelect(current)}>{t('files.selectFolder')}</button>
    </div>}
  </dialog>;
}
