import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalFrame, TerminalInput } from '../shared/types';
import { paintFrame, typedInput } from './terminal-input';
import { imeOwnsKey } from './enter-key';
import { t } from '../shared/i18n';
import { useDesktopState } from './desktop-state';

interface Props {
  frame: TerminalFrame;
  hint: string;
  shouldFocus(): boolean;
  onInput(input: TerminalInput): void;
  onError(message: string): void;
  leave(): void;
}

/** xterm owns the editable surface and composition overlay. It mirrors the
 * existing pane's physical grid; changing the desktop layout must not resize
 * another attached tmux client or alter the TUI being observed. */
export default function TerminalViewport(props: Props) {
  const { frame } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const current = useRef(props);
  current.current = props;
  const follow = useRef(true);

  useLayoutEffect(() => {
    const hostNode = host.current!, viewer = viewport.current!, { frame, hint } = current.current;
    const style = getComputedStyle(viewer);
    const term = new Terminal({ cols: frame.cols, rows: frame.rows, scrollback: 0, allowProposedApi: false,
      fontFamily: 'Menlo, Consolas, monospace', fontSize: parseFloat(style.fontSize), lineHeight: 1.25,
      cursorInactiveStyle: 'outline', theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
      // The pane follows the app theme, which may be light. Claude Code's own
      // colors assume whatever terminal it was styled for, so lift any color
      // that would fall below readable contrast on this background.
      minimumContrastRatio: 4.5,
    });
    terminal.current = term;
    term.open(hostNode);
    const textarea = term.textarea!;
    textarea.setAttribute('aria-label', t('files.terminalInput'));
    textarea.setAttribute('aria-describedby', hint);
    const acceptsInput = () => !document.hidden && document.activeElement === textarea;
    term.attachCustomKeyEventHandler(event => {
      if (!acceptsInput()) return false;
      if (event.key === 'F6' && event.type === 'keydown' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); current.current.leave(); return false;
      }
      // The browser (including Electron's Edit menu) must deliver an actual
      // paste event; do not turn Ctrl+V into the byte 0x16 as well.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return false;
      // In particular, Enter used to choose an IME candidate is not submission.
      if (event.isComposing && event.keyCode !== 229) return false;
      // An input method that keeps the keypad Enter to itself (keyCode 229 with
      // nothing composed) would leave xterm waiting for text: send Return.
      if (event.type === 'keydown' && event.code === 'NumpadEnter' && !imeOwnsKey(event) && event.keyCode === 229) {
        event.preventDefault();
        const input = typedInput('\r');
        if (input) { follow.current = true; current.current.onInput(input); }
        return false;
      }
      return true;
    });
    const listener = term.onData(data => {
      if (!acceptsInput()) return;
      const input = typedInput(data);
      if (input) { follow.current = true; current.current.onInput(input); }
      else current.current.onError(t('files.unsupportedKey'));
    });
    const paste = (event: ClipboardEvent) => {
      // Take this before xterm normalizes newlines or brackets the payload.
      event.preventDefault(); event.stopPropagation();
      if (!acceptsInput()) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      if (new TextEncoder().encode(text).length > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cs}]/u.test(text)) {
        current.current.onError(t('files.pasteLimit')); return;
      }
      follow.current = true; current.current.onInput({ type: 'text', text });
    };
    hostNode.addEventListener('paste', paste, true);
    if (current.current.shouldFocus()) term.focus();
    return () => {
      hostNode.removeEventListener('paste', paste, true); listener.dispose();
      terminal.current = undefined; term.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const term = terminal.current!;
    let active = true;
    term.resize(frame.cols, frame.rows);
    term.write(paintFrame(frame), () => {
      const viewer = viewport.current, grid = host.current?.querySelector('.xterm-screen');
      if (!active || !follow.current || !grid || !viewer) return;
      const bounds = grid.getBoundingClientRect(), clip = viewer.getBoundingClientRect();
      const w = bounds.width / frame.cols, h = bounds.height / frame.rows;
      const x = bounds.left + frame.cursorX * w, y = bounds.top + frame.cursorY * h;
      viewer.scrollBy(x < clip.left ? x - clip.left : Math.max(0, x + w - clip.left - viewer.clientWidth),
        y < clip.top ? y - clip.top : Math.max(0, y + h - clip.top - viewer.clientHeight));
    });
    return () => { active = false; };
  }, [frame.ansi, frame.cols, frame.rows, frame.cursorX, frame.cursorY, frame.cursorVisible]);

  // The grid's text is the viewport's (var(--text-meta)), so it follows the interface font
  // size. App applies a new size in its own effect, after this one: read it a frame later.
  const { fontSize } = useDesktopState();
  useEffect(() => {
    const next = requestAnimationFrame(() => {
      const term = terminal.current, viewer = viewport.current;
      const size = viewer ? parseFloat(getComputedStyle(viewer).fontSize) : 0;
      if (term && size && term.options.fontSize !== size) term.options.fontSize = size;
    });
    return () => cancelAnimationFrame(next);
  }, [fontSize]);

  return <div className="terminal-viewport" ref={viewport} onWheelCapture={() => { follow.current = false; }}>
    <div ref={host} className="terminal-grid" />
  </div>;
}
