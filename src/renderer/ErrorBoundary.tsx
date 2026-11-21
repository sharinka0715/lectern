import { Component, type ErrorInfo, type ReactNode } from "react";
import { LecternMark } from "./LecternMark";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { reportDiagnostic } from "./diagnostics";
import { t } from '../shared/i18n';

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; diagnosticsOpen: boolean }
> {
  state = { failed: false, diagnosticsOpen: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportDiagnostic({
      kind: "error",
      message: `React render failed: ${error.message}`,
      stack: `${error.stack || ""}\n${info.componentStack || ""}`,
      data: { source: "react-error-boundary" },
    });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="renderer-crash" role="alert">
        <LecternMark className="welcome-symbol" />
        <h1>{t('misc.crashTitle')}</h1>
        <p>{t('misc.crashBody')}</p>
        <div className="diagnostics-actions">
          <button
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            {t('misc.reloadUi')}
          </button>
          <button
            className="secondary-button"
            onClick={() => this.setState({ diagnosticsOpen: true })}
          >
            {t('misc.viewLogs')}
          </button>
        </div>
        {this.state.diagnosticsOpen && (
          <DiagnosticsPanel
            onClose={() => this.setState({ diagnosticsOpen: false })}
          />
        )}
      </main>
    );
  }
}
