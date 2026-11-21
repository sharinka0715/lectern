import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, X } from "lucide-react";
import { installHints, machineParams, OLDEST_TESTED_CLAUDE, CLAUDE_UPDATE, outdatedClaude, systemLabel, toolList, toolName, type HostTools } from "../shared/host-tools";
import { hostMissing, type HostToolsStatus } from "./host-tools";
import { t } from "../shared/i18n";
import "./host-tools.css";

/** One command with a copy button (the system clipboard through the main process). */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <div className="host-tools-command">
    <code>{command}</code>
    <button type="button" className="icon-button" aria-label={t('hostTools.copyCommand')} title={t(copied ? 'hostTools.copied' : 'hostTools.copyCommand')}
      onClick={() => void window.desktop.copyText(command).then(() => setCopied(true))}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
  </div>;
}

/**
 * A machine without tmux or Claude Code: what is missing, the install commands for its
 * system and Recheck. It has no close button; it goes away once a recheck finds both.
 * `machine`: the SSH machine's name, undefined for this computer.
 */
export function HostToolsNotice({ machineKey, machine, status, onRecheck }: { machineKey: string; machine?: string; status: HostToolsStatus; onRecheck(): void }) {
  const missing = hostMissing(status), tools = "tools" in status ? status.tools : undefined;
  if (!missing.length || !tools) return null;
  const checking = status.state === "checking";
  return <section className="host-tools-notice" role="alert" aria-label={t('hostTools.title', { ...machineParams(machine), tools: toolList(missing) })}
    data-machine-key={machineKey} data-missing={missing.join(" ")}>
    <div className="host-tools-heading">
      <AlertTriangle size={18}/>
      <strong>{t('hostTools.title', { ...machineParams(machine), tools: toolList(missing) })}</strong>
      <span className="host-tools-system">{t('hostTools.system', { system: systemLabel(tools) })}</span>
    </div>
    <p>{t('hostTools.explain')}</p>
    {missing.map(tool => <ToolSteps key={tool} tool={tool} tools={tools}/>)}
    <div className="host-tools-actions">
      <button type="button" onClick={onRecheck} disabled={checking}>
        {checking ? <Loader2 size={14} className="rotating"/> : <RefreshCw size={14}/>}{t(checking ? 'hostTools.checking' : 'hostTools.recheck')}
      </button>
    </div>
  </section>;
}

function ToolSteps({ tool, tools }: { tool: "tmux" | "claude"; tools: HostTools }) {
  const hints = installHints(tools, tool);
  return <div className="host-tools-tool" data-tool={tool}>
    <h4>{t('hostTools.installTool', { tool: toolName(tool) })}</h4>
    {hints.length ? hints.map(hint => <div key={hint.command} className="host-tools-step">
      <span>{t(hint.label, hint.params)}</span>
      <CommandLine command={hint.command}/>
    </div>) : <span>{t('hostTools.noHint')}</span>}
    {tool === "claude" && <p className="host-tools-note">{t('hostTools.signInAfter')}</p>}
  </div>;
}

/** A check that could not run (not a missing tool): said quietly, with Recheck. */
export function HostCheckFailed({ machine, message, onRecheck }: { machine?: string; message: string; onRecheck(): void }) {
  return <div className="notice-banner host-check-failed" role="status">
    <span>{t('hostTools.checkFailed', { ...machineParams(machine), message })}</span>
    <button type="button" onClick={onRecheck}>{t('hostTools.recheck')}</button>
  </div>;
}

// Dismissed warnings stay dismissed for the window's life (per machine and version).
const dismissed = new Set<string>();
/** Claude Code older than the oldest tested version: a gentle warning, never a block. */
export function OutdatedClaude({ machineKey, machine, tools }: { machineKey: string; machine?: string; tools: HostTools }) {
  const version = outdatedClaude(tools), id = `${machineKey}\n${version}`;
  const [, setRevision] = useState(0);
  if (!version || dismissed.has(id)) return null;
  return <div className="notice-banner host-tools-outdated" role="status" data-machine-key={machineKey}>
    <span>{t('hostTools.outdated', { ...machineParams(machine), version, oldest: OLDEST_TESTED_CLAUDE })}</span>
    <CommandLine command={CLAUDE_UPDATE}/>
    <button type="button" className="icon-button" aria-label={t('hostTools.dismiss')} title={t('hostTools.dismiss')}
      onClick={() => { dismissed.add(id); setRevision(n => n + 1); }}><X size={14}/></button>
  </div>;
}
