import type { Workspace } from '../shared/types';
import type { WorkspaceArtifacts } from '../backend/artifacts';
import { t } from '../shared/i18n';

interface Dialogs {
  allowOutside(workspace: Workspace, path: string): Promise<boolean>;
  saveAs(name: string): Promise<string | undefined>;
}

/** Permission is attached to the approved target and window, never its parent. */
export class ArtifactAccess {
  private grants = new Map<string, Map<string, 'file' | 'directory'>>();
  constructor(
    private readonly getWorkspace: (id: string) => Workspace,
    private readonly artifacts: WorkspaceArtifacts,
    private readonly dialogs: Dialogs,
  ) {}
  reset() { this.grants = new Map(); }
  private context(id: string) {
    const workspace = this.getWorkspace(id), identity = JSON.stringify(workspace);
    const windowGrants = this.grants;
    const check = () => {
      if (windowGrants !== this.grants || JSON.stringify(this.getWorkspace(id)) !== identity) throw new Error(t('main.workspaceOrWindowChanged'));
    };
    let approved: string | undefined;
    const authorize = async (path: string) => {
      check();
      const grants = windowGrants.get(identity);
      if (grants) {
        for (const [allowed, type] of grants) {
          if (allowed === path || type === 'directory' && path.startsWith(allowed.replace(/\/$/, '') + '/')) return;
        }
      }
      if (!await this.dialogs.allowOutside(workspace, path)) throw new Error(t('main.outsideAccessCancelled'));
      check();
      approved = path;
    };
    const remember = (kind: 'file' | 'directory') => {
      check();
      if (!approved) return;
      const grants = windowGrants.get(identity) ?? new Map<string, 'file' | 'directory'>();
      grants.set(approved, kind);
      windowGrants.set(identity, grants);
    };
    return { workspace, authorize, remember, check };
  }
  async resolve(id: string, references: string[]) {
    const request = this.context(id);
    const matches = await this.artifacts.resolveReferences(request.workspace, references);
    request.check();
    return matches;
  }
  async list(id: string, path?: string, offset?: number) {
    const request = this.context(id);
    const result = await this.artifacts.list(request.workspace, path, offset, request.authorize);
    request.remember('directory');
    return result;
  }
  async preview(id: string, path: string) {
    const request = this.context(id);
    const result = await this.artifacts.preview(request.workspace, path, request.authorize);
    request.remember(result.kind === 'directory' ? 'directory' : 'file');
    return result;
  }
  async previewInlineImage(id: string, path: string) {
    const request = this.context(id);
    // 聊天中的自动预览只读取工作区，目录外确认仅由显式打开文件触发。
    const preview = await this.artifacts.preview(request.workspace, path);
    request.check();
    if (preview.kind !== 'image') throw new Error(preview.notice || t('main.notAnImage'));
    return preview;
  }
  async previewInlineImageThumbnail(id: string, path: string) {
    const request = this.context(id);
    // No grants or dialogs for automatic loads, even after an explicit outside-file preview.
    const preview = await this.artifacts.thumbnail(request.workspace, path);
    request.check();
    return preview;
  }
  /** A file the conversation attached by path (taken from the transcript, never from the renderer):
   * thumbnailed even outside the folder, still without grants or dialogs. */
  async attachmentThumbnail(id: string, path: string) {
    const request = this.context(id);
    const preview = await this.artifacts.thumbnail(request.workspace, path, true);
    request.check();
    return preview;
  }
  async download(id: string, path: string) {
    const request = this.context(id);
    const source = await this.artifacts.prepareDownload(request.workspace, path, request.authorize);
    request.remember('file');
    const destination = await this.dialogs.saveAs(source.name);
    if (!destination) return false;
    request.check();
    await source.saveTo(destination);
    return true;
  }
}
