import { useMemo, useState } from 'react';
import { structuredPatch } from 'diff';
import type { ToolBlock } from '../shared/types';
import type { EditHunk } from '../shared/edit-patch';
import { FileLink } from './ArtifactLinks';
import { sedEdit } from '../shared/sed-edit';
import './edit-diff.css';
import { t } from '../shared/i18n';
import { useLocale } from './i18n';

interface Replacement { old_string: string; new_string: string; replace_all?: boolean }
function replacement(input: unknown): input is Replacement {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<Replacement>;
  return typeof candidate.old_string === 'string' && typeof candidate.new_string === 'string';
}

function readEdit(input: string, name?: string) {
  try {
    const data = JSON.parse(input);
    if (!data) return;
    const sed = name === 'Bash' && typeof data.command === 'string' ? sedEdit(data.command) : undefined;
    if (sed) return { path: sed.files[0], edits: sed.edits as Replacement[], cell: undefined, proposed: undefined, sed: { ...sed, command: data.command as string } };
    const file = data.file_path ?? data.notebook_path;
    if (typeof file !== 'string') return;
    const edits = Array.isArray(data.edits) ? data.edits.filter(replacement) : replacement(data) ? [data] : [];
    return { path: file as string, edits: edits as Replacement[], cell: typeof data.cell_id === 'string' ? data.cell_id : undefined, proposed: typeof data.new_source === 'string' ? data.new_source : undefined };
  } catch { return; }
}

// A legacy or pending input contains snippets, so its row numbers are relative.
function fragmentHunks(edits: Replacement[]): EditHunk[] {
  return edits.flatMap(({ old_string, new_string }) => {
    if (old_string === new_string) return [];
    const diff = structuredPatch('', '', old_string, new_string, undefined, undefined, { context: 3, timeout: 25 });
    if (diff) return diff.hunks;
    const split = (s: string) => s ? s.split(/\r?\n/) : [];
    const old = split(old_string), next = split(new_string);
    return [{ oldStart: 1, newStart: 1, oldLines: old.length, newLines: next.length,
      lines: [...old.map(line => '-' + line), ...next.map(line => '+' + line)] }];
  });
}

export function EditDiff({ tool, onOpenPath }: { tool: ToolBlock; onOpenPath: (path: string) => void }) {
  const [limit, setLimit] = useState(160);
  // sed notes are written in the current language.
  const locale = useLocale();
  const edit = useMemo(() => readEdit(tool.input, tool.name), [tool.input, tool.name, locale]);
  const hunks = useMemo(() => tool.editPatch ?? fragmentHunks(tool.cellEdit ? [{ old_string: tool.cellEdit.before, new_string: tool.cellEdit.after }] : edit?.edits ?? []), [tool.editPatch, tool.cellEdit, edit]);
  if (!edit) return <pre>{tool.input}</pre>;
  let remaining = limit;
  const total = hunks.reduce((sum, h) => sum + h.lines.length, 0);
  const sed = edit && 'sed' in edit ? edit.sed : undefined;
  const state = t(tool.isError ? 'chat.appliedFailed' : tool.editPatch || tool.cellEdit ? 'chat.appliedChange' :
    tool.result === undefined ? 'chat.pendingChange' : sed ? 'chat.sedChange' : 'chat.inputChange');
  return <section className="edit-diff" aria-label={t('chat.editDiff')} data-diff-source={tool.editPatch || tool.cellEdit ? 'native' : 'input'}>
    <header><FileLink path={edit.path} onOpen={onOpenPath}>{edit.path}</FileLink><span>{state}</span></header>
    {sed && sed.files.length > 1 && <div className="edit-diff-note">{t('chat.alsoChanged')}{sed.files.slice(1).map(file => <FileLink key={file} path={file} onOpen={onOpenPath}>{file} </FileLink>)}</div>}
    {!!hunks.length && !tool.editPatch && <div className="edit-diff-note">{tool.cellEdit ? t('chat.cell', { cell: edit.cell ?? '' }) : sed ? t('chat.sedRules', { regex: sed.regex }) : t('chat.replacedFragment')}{t('chat.relativeLines')}{edit.edits.some(e => e.replace_all) && t('chat.allMatches')}</div>}
    {sed?.notes.map(note => <div className="edit-diff-note" key={note}>{note}</div>)}
    {hunks.map((hunk, index) => {
      if (remaining <= 0) return null;
      let oldNo = hunk.oldStart, newNo = hunk.newStart;
      const lines = hunk.lines.slice(0, remaining);
      remaining -= lines.length;
      return <div className="edit-diff-hunk" key={index}>
        <div className="edit-diff-range">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
        {lines.map((line, n) => {
          const sign = line.charAt(0), marker = sign === '\\';
          return <div key={n} className={'edit-diff-line ' + (sign === '+' ? 'added' : sign === '-' ? 'removed' : '')}>
            <span>{sign === '+' || marker ? '' : oldNo++}</span><span>{sign === '-' || marker ? '' : newNo++}</span><code>{line || ' '}</code>
          </div>;
        })}
      </div>;
    })}
    {!hunks.length && !tool.cellEdit && edit.proposed !== undefined && <div className="edit-diff-note">{t('chat.proposedCell')}<pre>{edit.proposed}</pre></div>}
    {!hunks.length && edit.proposed === undefined && !sed?.notes.length && <div className="edit-diff-note">{t(edit.edits.length ? 'chat.sameContent' : 'chat.noDiff')}</div>}
    {sed && <div className="edit-diff-note edit-diff-command">{t('chat.command')}<pre>{sed.command}</pre></div>}
    {total > limit && <button className="edit-diff-more" onClick={() => setLimit(n => n + 300)}>{t('chat.moreDiff', { count: total - limit })}</button>}
  </section>;
}
