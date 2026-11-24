import type { HistoryTarget, Workspace } from "../shared/types";

/** Lexical matching only: never replace the original cwd used by Claude's history. */
export function historyDirectoryKey(value: string) {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function sameHistoryTarget(
  workspace: Workspace,
  target: HistoryTarget,
) {
  if (workspace.kind !== target.kind) return false;
  if (
    workspace.kind === "ssh" &&
    (workspace.host !== target.host || workspace.port !== target.port)
  )
    return false;
  return true;
}

export function findImportedWorkspace(
  workspaces: Workspace[],
  target: HistoryTarget,
  cwd: string,
) {
  return workspaces.find(
    (workspace) =>
      sameHistoryTarget(workspace, target) &&
      historyDirectoryKey(workspace.cwd) === historyDirectoryKey(cwd),
  );
}
