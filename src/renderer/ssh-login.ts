import { useSyncExternalStore } from 'react';
import type { SshLoginTarget } from '../shared/types';

/** Errors after which logging in may help: authentication, or a host key not yet trusted. */
const loginErrors = /Permission denied|Host key verification failed|No \S+ host key is known|Authentication failed|authentication failures|keyboard-interactive|Connection closed by|passphrase/i;
export function needsSshLogin(message: string | undefined) { return !!message && loginErrors.test(message); }

export interface SshLoginRequest {
  id: number;
  target: SshLoginTarget;
  /** Shown in the dialog title, for example the saved connection name. */
  label?: string;
  /** Runs once a reusable connection exists, for example to retry what failed. */
  onDone?: () => void;
  onClose?: () => void;
}

// One login dialog for the whole window; any panel can ask for it.
let current: SshLoginRequest | undefined;
let sequence = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function openSshLogin(target: SshLoginTarget, options: Pick<SshLoginRequest, 'label' | 'onDone' | 'onClose'> = {}) {
  current?.onClose?.();
  current = { id: ++sequence, target: { host: target.host, ...(target.port ? { port: target.port } : {}) }, ...options };
  notify();
}
export function closeSshLogin(id: number) {
  if (current?.id !== id) return;
  current.onClose?.();
  current = undefined;
  notify();
}
export function useSshLoginRequest() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}
