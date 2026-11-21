import type { RendererDiagnostic, SessionSnapshot } from "../shared/types";

let context: { workspaceId?: string; sessionId?: string } = {};
let installed = false;
let previousSignature = "";
let lastRenderReport = 0;
let pendingRender: RendererDiagnostic | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let renderSequence = 0;

export function setDiagnosticContext(workspaceId?: string, sessionId?: string) {
  context = { workspaceId, sessionId };
}

export function reportDiagnostic(report: RendererDiagnostic) {
  // Diagnostics must never become another source of unhandled UI errors.
  try {
    void window.desktop
      ?.reportRendererDiagnostic({ ...context, ...report })
      .catch(() => {});
  } catch {
    /* A preload failure is handled by the visible error boundary. */
  }
}

export function reportActionError(error: unknown, operation = "界面操作失败") {
  reportDiagnostic({
    kind: "action",
    message: `${operation}: ${error instanceof Error ? error.message : String(error)}`,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export function installRendererDiagnostics() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportDiagnostic({
      kind: "error",
      message: event.message || "Renderer resource error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
      data: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    reportDiagnostic({
      kind: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  window.addEventListener("pagehide", flushRenderReport);
}

function flushRenderReport() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = undefined;
  if (!pendingRender) return;
  lastRenderReport = Date.now();
  reportDiagnostic(pendingRender);
  pendingRender = undefined;
}

/** Called after React commits a snapshot. Raw text is captured by the main process only. */
export function reportSnapshotApplied(snapshot: SessionSnapshot) {
  const signature = [
    snapshot.workspaceId,
    snapshot.sessionId,
    snapshot.paneId,
    snapshot.status,
    ...snapshot.messages.map((message) =>
      [
        message.id,
        message.role,
        message.source,
        message.status,
        message.text.length,
        ...message.tools.map((tool) =>
          [
            tool.id,
            tool.input.length,
            tool.result?.length ?? -1,
            tool.isError,
          ].join(":"),
        ),
      ].join(":"),
    ),
  ].join("|");
  if (signature === previousSignature) return;
  previousSignature = signature;
  const lastMessage = snapshot.messages.at(-1);
  pendingRender = {
    kind: "render",
    message: "Snapshot applied",
    workspaceId: snapshot.workspaceId,
    sessionId: snapshot.sessionId,
    data: {
      sequence: ++renderSequence,
      status: snapshot.status,
      paneId: snapshot.paneId,
      messageCount: snapshot.messages.length,
      userCount: snapshot.messages.filter((message) => message.role === "user")
        .length,
      assistantCount: snapshot.messages.filter(
        (message) => message.role === "assistant",
      ).length,
      toolCount: snapshot.messages.reduce(
        (count, message) => count + message.tools.length,
        0,
      ),
      totalCharacters: snapshot.messages.reduce(
        (count, message) => count + message.text.length,
        0,
      ),
      previewCharacters: snapshot.messages
        .filter((message) => message.source === "preview")
        .reduce((count, message) => count + message.text.length, 0),
      recentMessageIds: snapshot.messages
        .slice(-12)
        .map((message) => message.id)
        .join(","),
      lastMessageId: lastMessage?.id,
      lastMessageRole: lastMessage?.role,
      lastMessageSource: lastMessage?.source,
      lastMessageStatus: lastMessage?.status,
      lastMessageCharacters: lastMessage?.text.length,
      screenCharacters: snapshot.screen.length,
      hasError: !!snapshot.error,
      hasNotice: !!snapshot.notice,
    },
  };
  const remaining = 500 - (Date.now() - lastRenderReport);
  if (remaining <= 0) flushRenderReport();
  else if (!renderTimer) renderTimer = setTimeout(flushRenderReport, remaining);
}
