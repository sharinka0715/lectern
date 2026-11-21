import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { diagnostic, redactText } from '../diagnostics';
import type { SessionSettingOption } from '../shared/types';
import type { SessionSettingsHandle } from './session-settings-cache';

type Selection = Pick<SessionSettingOption, 'label' | 'description'>;
export interface VerifiedSelections { model?: Selection; effort?: Selection }
const maxSessions = 128;
const maxRecordBytes = 16 * 1024;
const recordName = /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function binding(handle: SessionSettingsHandle): string | undefined {
  if (!handle.instanceId) return;
  return digest(JSON.stringify([handle.targetKey, handle.sessionId, handle.instanceId, handle.paneId, handle.panePid]));
}

function safeText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !!value.trim()
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value) && redactText(value) === value;
}

/** Project even parsed JSON onto known display fields. A stored observation
 * never contains a menu, a choice ID or anything the native setter accepts. */
function selection(value: unknown): Selection | undefined {
  if (!value || typeof value !== 'object' || !('label' in value) || !safeText(value.label, 256)) return;
  if ('description' in value && value.description !== undefined) {
    if (!safeText(value.description, 1024)) return;
    return { label: value.label, description: value.description };
  }
  return { label: value.label };
}

/** The Electron profile has one owner. A single small atomic file per session
 * makes invalidation synchronous before control leaves for a native mutation. */
export class SessionSettingsDiskStore {
  private readonly directory: string;
  private disabled = false;

  constructor(userDataDirectory: string) {
    this.directory = path.join(userDataDirectory, 'session-settings');
  }

  private file(targetKey: string, sessionId: string): string {
    return path.join(this.directory, `${digest(targetKey)}-${digest(sessionId)}.json`);
  }

  private checkDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Unsafe settings cache directory');
    }
  }

  private disable(operation: string, error: unknown): void {
    if (!this.disabled) diagnostic.event('settings.disk_cache.unavailable', { operation, code: (error as NodeJS.ErrnoException).code }, 'warn');
    this.disabled = true;
  }

  read(handle: SessionSettingsHandle): VerifiedSelections | undefined {
    const instance = binding(handle);
    if (this.disabled || !instance) return;
    try {
      this.checkDirectory();
      accessSync(this.directory, constants.W_OK);
      const file = this.file(handle.targetKey, handle.sessionId);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > maxRecordBytes || (process.platform !== 'win32' && (stat.mode & 0o077))) return;
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record?.version !== 1 || record.instance !== instance) return;
      const model = selection(record.model), effort = selection(record.effort);
      if (('model' in record && !model) || ('effort' in record && !effort)) return;
      if (model || effort) return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) this.disable('read', error);
    }
  }

  write(handle: SessionSettingsHandle, selections: VerifiedSelections): void {
    const instance = binding(handle);
    if (!instance) return;
    if (this.disabled) {
      // The directory may have recovered since reads/writes were disabled.
      // Still revoke a prior record when a newer observation supersedes it.
      this.remove(handle.targetKey, handle.sessionId);
      return;
    }
    const model = selection(selections.model), effort = selection(selections.effort);
    if (!model && !effort) { this.remove(handle.targetKey, handle.sessionId); return; }
    const file = this.file(handle.targetKey, handle.sessionId);
    // One writer per profile; an interrupted write can leave only this staging
    // file, which is never used for restoration.
    const staging = path.join(this.directory, '.pending');
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.checkDirectory();
      const files = readdirSync(this.directory).filter(name => recordName.test(name) && name !== path.basename(file));
      if (files.length >= maxSessions) {
        const byAge = files.map(name => ({ name, time: lstatSync(path.join(this.directory, name)).mtimeMs }))
          .sort((a, b) => a.time - b.time);
        for (const { name } of byAge.slice(0, files.length - maxSessions + 1)) unlinkSync(path.join(this.directory, name));
      }
      try { unlinkSync(staging); } catch (error) { if (!missing(error)) throw error; }
      writeFileSync(staging, JSON.stringify({ version: 1, instance, model, effort }), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(staging, file);
    } catch (error) {
      // A failed refresh must not leave a previously observed selection valid.
      this.remove(handle.targetKey, handle.sessionId);
      this.disable('write', error);
    }
  }

  remove(targetKey: string, sessionId: string): void {
    const file = this.file(targetKey, sessionId);
    try {
      this.checkDirectory();
      this.erase(file);
    } catch (error) { if (!missing(error)) this.disable('remove', error); }
  }

  private erase(file: string): void {
    try { unlinkSync(file); } catch (error) {
      if (missing(error)) return;
      // A read-only directory can still contain a writable file. Leave an
      // invalid (empty) record there if the directory entry cannot be removed.
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) throw error;
      const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw error;
        ftruncateSync(fd, 0);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  }

  removeTarget(targetKey: string): void {
    const prefix = digest(targetKey) + '-';
    try {
      this.checkDirectory();
      for (const name of readdirSync(this.directory)) {
        if (recordName.test(name) && name.startsWith(prefix)) this.erase(path.join(this.directory, name));
      }
    } catch (error) { if (!missing(error)) this.disable('removeTarget', error); }
  }
}
