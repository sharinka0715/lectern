import type { WorkspaceEndpoint } from './types';
import type { ModelCatalog } from './model-catalog';

export interface SettingsLaunch { id: string; nonce: string }
export interface SettingsInspection { launch?: boolean; sessionId?: string; nonce?: string }
export interface NewConversationOptions { model?: string; effort?: string; validateMessage?: string; settingsFile?: string | null; launch?: SettingsLaunch }
export interface ConversationSettingsRecord { settingsFile: string | null }
export interface SettingsOverride { key: string; userValue: string; lecternValue: string }
export interface SettingsOverrideSource { file: string; items: SettingsOverride[] }
export interface SettingsValidationIssue { file: string; path: string; message: string }
export interface SettingsFileValidation {
  settingsFile: string | null;
  overrides: SettingsOverrideSource[];
  error?: string;
  issues?: SettingsValidationIssue[];
  catalog?: ModelCatalog;
}

export const conversationSettingsKey = (target: WorkspaceEndpoint, sessionId: string) =>
  JSON.stringify([target.kind, target.host ?? null, target.port ?? null, sessionId]);
