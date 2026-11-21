import type { HistoryTarget, Workspace } from "../shared/types";

/** Lexical matching only: never replace the original cwd used by Claude's history. */
export function historyDirectoryKey(value: string) {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function sameHistoryTarget(
  workspace: Workspace,
  target: HistoryTarget,
  resolvedClaudeDir?: string,
) {
  if (workspace.kind !== target.kind) return false;
  if (
    workspace.kind === "ssh" &&
    (workspace.host !== target.host || workspace.port !== target.port)
  )
    return false;
  // An omitted override inherits the target environment and native global config
  // location. Even an explicit path to the same project directory changes that
  // mode, so it must not silently select a differently configured workspace.
  if (!!workspace.claudeDir !== !!target.claudeDir) return false;
  if (!workspace.claudeDir || !target.claudeDir) return true;
  const stored = historyDirectoryKey(workspace.claudeDir);
  const requested = historyDirectoryKey(target.claudeDir);
  if (stored === requested) return true;
  // Resolve aliases only when both sides explicitly selected a config directory.
  return (
    !!resolvedClaudeDir && stored === historyDirectoryKey(resolvedClaudeDir)
  );
}

export function findImportedWorkspace(
  workspaces: Workspace[],
  target: HistoryTarget,
  cwd: string,
  resolvedClaudeDir?: string,
) {
  return workspaces.find(
    (workspace) =>
      sameHistoryTarget(workspace, target, resolvedClaudeDir) &&
      historyDirectoryKey(workspace.cwd) === historyDirectoryKey(cwd),
  );
}
