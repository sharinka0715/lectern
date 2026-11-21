import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldQuestion, Terminal } from "lucide-react";
import type {
  DirectoryTrustDecision,
  DirectoryTrustSnapshot,
} from "../shared/types";
import { reportActionError } from "./diagnostics";
import { confirmedDirectoryTrustResult } from "./directory-trust-state";
import { t } from '../shared/i18n';

export function DirectoryTrustCard({
  workspaceId,
  prompt,
  busy,
  onViewTerminal,
  onExited,
}: {
  workspaceId: string;
  prompt: DirectoryTrustSnapshot;
  busy?: boolean;
  onViewTerminal(): void;
  /** Parent guards the current selection; exit can unmount this card first. */
  onExited(): void;
}) {
  const alive = useRef(true);
  const submitting = useRef(false);
  const [pending, setPending] = useState<DirectoryTrustDecision>();
  const [completed, setCompleted] = useState<DirectoryTrustDecision>();
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const decline = prompt.cancelDecision ?? "exit";
  const disabled = !!busy || !!pending || !!completed;

  async function respond(decision: DirectoryTrustDecision) {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setPending(decision);
    setError("");
    try {
      const result = await window.desktop.respondDirectoryTrust(
        workspaceId,
        prompt.sessionId,
        prompt.token,
        decision,
      );
      if (
        !confirmedDirectoryTrustResult(result, {
          sessionId: prompt.sessionId,
          paneId: prompt.paneId,
          decision,
        })
      )
        throw new Error(t('cards.trustMismatch'));
      if (decision === "exit") {
        onExited();
        return;
      }
      if (!alive.current) return;
      setCompleted(decision);
    } catch (failure) {
      reportActionError(failure, "目录信任确认失败");
      if (alive.current)
        setError(
          failure instanceof Error
            ? failure.message.replace(
                /^Error invoking remote method '[^']+': (?:Error: )?/,
                "",
              )
            : String(failure),
        );
    } finally {
      submitting.current = false;
      if (alive.current) setPending(undefined);
    }
  }

  return (
    <section
      className="directory-trust-card"
      aria-label={t('cards.trustLabel')}
      data-directory-trust-cwd={prompt.cwd}
      data-directory-trust-scope={prompt.scope}
      data-directory-trust-busy={disabled}
    >
      <div className="directory-trust-heading">
        <ShieldQuestion size={18} aria-hidden="true" />
        <strong>{t('cards.trustTitle')}</strong>
        {prompt.scope === "session" && <span>{t('cards.sessionOnly')}</span>}
      </div>
      <div className="directory-trust-body">
        <code className="directory-trust-path">{prompt.cwd}</code>
        <p>
          {t('cards.trustExplain')}
        </p>
        {prompt.scope === "session" && (
          <p className="directory-trust-scope">
            {t('cards.sessionScopeNote')}
          </p>
        )}
        {prompt.warnings?.length ? <div className="setting-menu-warning">{prompt.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div> : null}
        {prompt.disclosure && <p className="directory-trust-disclosure" data-directory-trust-disclosure>{prompt.disclosure}</p>}
        <details className="directory-trust-native-labels">
          <summary>{t('cards.nativeOptions')}</summary>
          <span>{prompt.acceptLabel}</span>
          <span>{prompt.cancelLabel}</span>
        </details>
        {error && (
          <div className="directory-trust-error" role="alert">
            {error}
          </div>
        )}
        {completed && (
          <p className="directory-trust-result" role="status">
            {completed === "trust"
              ? t('cards.trusted')
              : t('cards.declined')}
          </p>
        )}
      </div>
      <div className="directory-trust-actions">
        <button
          className="directory-trust-view"
          type="button"
          onClick={onViewTerminal}
        >
          <Terminal size={13} />
          {t('cards.viewNativePrompt')}
        </button>
        <div>
          <button
            className="secondary-button"
            type="button"
            data-trust-decision={decline}
            disabled={disabled}
            onClick={() => void respond(decline)}
          >
            {pending === decline && <Loader2 size={13} className="rotating" />}
            {t(decline === "continue" ? 'cards.declineContinue' : 'cards.cancelExit')}
          </button>
          <button
            className="primary-button"
            type="button"
            data-trust-decision="trust"
            disabled={disabled}
            onClick={() => void respond("trust")}
          >
            {pending === "trust" && <Loader2 size={13} className="rotating" />}
            {t('cards.trustContinue')}
          </button>
        </div>
      </div>
    </section>
  );
}
