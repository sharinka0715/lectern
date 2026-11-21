import type { DirectoryTrustDecision, DirectoryTrustResult, SessionSnapshot } from "../shared/types";

/** Only a current backend-identified folder prompt can expose trust actions. */
export function activeDirectoryTrust(snapshot?: SessionSnapshot) {
  const prompt = snapshot?.directoryTrust;
  if (
    !snapshot ||
    snapshot.status !== "waiting" ||
    !snapshot.paneId ||
    !prompt ||
    prompt.sessionId !== snapshot.sessionId ||
    prompt.paneId !== snapshot.paneId ||
    !prompt.token ||
    !prompt.cwd ||
    !prompt.acceptLabel ||
    !(prompt.cancelLabel === "No, exit" && (prompt.cancelDecision ?? "exit") === "exit"
      || prompt.cancelLabel === "No, continue without these permissions" && prompt.cancelDecision === "continue") ||
    !["session", "unspecified"].includes(prompt.scope)
  )
    return undefined;
  return prompt;
}

export function confirmedDirectoryTrustResult(
  result: DirectoryTrustResult,
  expected: { sessionId: string; paneId: string; decision: DirectoryTrustDecision },
) {
  return (
    result.closed === true &&
    result.sessionId === expected.sessionId &&
    result.paneId === expected.paneId &&
    result.decision === expected.decision
  );
}
