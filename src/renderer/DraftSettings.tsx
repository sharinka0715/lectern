import { useEffect, useRef, useState } from "react";
import { Box, Check, ChevronDown, Loader2, RefreshCw, X } from "lucide-react";
import { defaultModelChoice, effortsFor, validLaunchChoices, type LaunchChoices, type ModelCatalogState } from "../shared/model-catalog";
import { tip } from "./Tooltip";
import { reportActionError } from "./diagnostics";
import { t } from '../shared/i18n';

type Kind = "model" | "effort";
const names = (kind: Kind) => t(kind === "model" ? 'settings.model' : 'settings.effort');
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

/** Model and effort for a new chat that has not started. The lists are the
 * machine's (read once per run); the choice applies to this chat's launch only
 * and is never saved as a default. */
export function DraftSettings({ workspaceId, choices, onChange, disabled }: {
  workspaceId: string; choices: LaunchChoices; onChange(next: LaunchChoices): void; disabled?: boolean;
}) {
  const [state, setState] = useState<ModelCatalogState>({ status: "loading" });
  const [openKind, setOpenKind] = useState<Kind>();
  const container = useRef<HTMLDivElement>(null);
  const load = (retry = false) => {
    let live = true;
    setState({ status: "loading" });
    window.desktop.modelCatalog(workspaceId, retry).then(next => { if (live) setState(next); }, error => {
      reportActionError(error, "读取模型列表失败");
      if (live) setState({ status: "failed", error: errorText(error) });
    });
    return () => { live = false; };
  };
  useEffect(() => load(), [workspaceId]);
  const catalog = state.status === "ready" ? state.catalog : undefined;
  // Another folder or machine may not offer the earlier choice.
  useEffect(() => {
    if (!catalog) return;
    const valid = validLaunchChoices(catalog, choices);
    if (valid.model !== choices.model || valid.effort !== choices.effort) onChange(valid);
  }, [catalog, choices, onChange]);
  useEffect(() => {
    if (!openKind) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpenKind(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpenKind(undefined); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [openKind]);
  const defaultRow = catalog && defaultModelChoice(catalog);
  const modelRow = catalog?.models.find(row => row.value === choices.model);
  const levels = catalog ? effortsFor(catalog, choices.model) : [];
  const defaultEffort = catalog?.defaults.effort && levels.includes(catalog.defaults.effort) ? catalog.defaults.effort : undefined;
  const label = (kind: Kind) => kind === "model"
    ? modelRow?.label ?? (defaultRow ? t('settings.defaultValue', { value: defaultRow.label }) : names("model"))
    : choices.effort ?? (defaultEffort ? t('settings.defaultValue', { value: defaultEffort }) : names("effort"));
  const rows = openKind === "model"
    ? [{ key: "", value: undefined, label: t('settings.default'), description: defaultRow ? t('settings.defaultModelFor', { label: defaultRow.label }) : t('settings.defaultModel') },
      ...(catalog?.models ?? []).filter(row => row.value !== "default").map(row => ({ key: row.value, value: row.value, label: row.label, description: row.description }))]
    : [{ key: "", value: undefined, label: t('settings.default'), description: defaultEffort ? t('settings.defaultEffortFor', { label: defaultEffort }) : t('settings.defaultEffort') },
      ...levels.map(level => ({ key: level, value: level, label: level, description: undefined }))];
  function choose(value: string | undefined) {
    if (openKind === "model") onChange(validLaunchChoices(catalog, { model: value, effort: choices.effort }));
    else onChange({ ...choices, effort: value as LaunchChoices["effort"] });
    setOpenKind(undefined);
  }
  return <div className="session-settings draft-settings" ref={container} data-draft-settings={state.status}>
    {(["model", "effort"] as const).map(kind => <button key={kind} type="button" className={`session-setting-trigger${openKind === kind ? " selected" : ""}`}
      data-setting-kind={kind} aria-label={t('settings.choose', { kind })} aria-haspopup="dialog" aria-expanded={openKind === kind}
      disabled={disabled || (kind === "effort" && !!catalog && !levels.length)}
      {...tip(t('settings.draftTitle', { kind, label: label(kind) }), kind === "effort" && catalog && !levels.length ? t('settings.effortUnsupported')
        : `${t(kind === "model" ? 'settings.draftModelHelp' : 'settings.draftEffortHelp')}\n${t('settings.draftScope')}`)}
      onClick={() => setOpenKind(openKind === kind ? undefined : kind)}>
      {kind === "model" && <span className="mini-claude" aria-hidden="true"><Box size={14} strokeWidth={1.7} /></span>}
      <span>{label(kind)}</span>{state.status === "loading" && openKind === kind ? <Loader2 size={11} className="rotating" /> : <ChevronDown size={11} />}
    </button>)}
    {openKind && <section className="session-setting-menu" role="dialog" aria-label={t('settings.choose', { kind: openKind })} data-setting-menu={openKind}>
      <div className="setting-menu-heading"><strong>{names(openKind)}</strong>
        <button className="icon-button" type="button" aria-label={t('settings.closeMenu')} onClick={() => setOpenKind(undefined)}><X size={14} /></button></div>
      {state.status === "loading" && <div className="setting-menu-loading" role="status"><Loader2 size={15} className="rotating" /><span>{t('settings.readingModels')}</span></div>}
      {state.status === "failed" && <div className="setting-menu-error" role="alert">{state.error}</div>}
      {catalog && <div className="setting-options" role="listbox" aria-label={t('settings.available', { kind: openKind })}>
        {rows.map(row => {
          const chosen = (openKind === "model" ? choices.model : choices.effort) === row.value;
          return <button type="button" className="setting-option" role="option" key={row.key} data-option-value={row.key} aria-selected={chosen}
            onClick={() => choose(row.value)} title={row.description ? `${row.label}\n${row.description}` : row.label}>
            <span><strong>{row.label}</strong>{row.description && <small>{row.description}</small>}</span>{chosen ? <Check size={13} /> : null}
          </button>;
        })}
      </div>}
      <div className="setting-menu-footer"><span role="status">{t(state.status === "failed" ? 'settings.retryOrDefault' : 'settings.draftFooter')}</span>
        {state.status === "failed" && <button className="icon-button" type="button" aria-label={t('settings.reread', { kind: openKind })} title={t('settings.rereadTitle')}
          onClick={() => load(true)}><RefreshCw size={13} /></button>}</div>
    </section>}
  </div>;
}
