import { Component, createRef, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Laptop, Server } from "lucide-react";
import type { ChatMessage, MessageAttachment, SessionSnapshot, Workspace } from "../shared/types";
import type { ArtifactTarget } from "./ArtifactDrawer";
import { ArtifactReferenceScope } from "./ArtifactReferenceScope";
import { MessageDisplay } from "./MessageDisplay";
import { ConversationTaskList } from './ConversationTaskList';
import type { ReplyDetail } from "./desktop-state";
import { t } from '../shared/i18n';

interface Props {
  workspace?: Workspace;
  sessionId?: string;
  replyDetail: ReplyDetail;
  messages?: ChatMessage[];
  tasks?: SessionSnapshot['tasks'];
  historyPage?: SessionSnapshot["historyPage"];
  loadEarlier: (cursor: string) => Promise<void>;
  onFollowLatest: (following: boolean) => void;
  onRewind?: (uuid: string) => void;
  /** Right-click t('composer.quote'): quote text into the composer. */
  onQuote?: (text: string) => void;
  openArtifact: (target: ArtifactTarget) => void;
  /** Floats over the conversation's top right corner (the activity card). */
  overlay?: ReactNode;
  /** The input area floating over the bottom of the conversation: the messages
   * scroll under it (the scrollbar runs to the bottom) and end above it. */
  dock?: HTMLElement | null;
  children: ReactNode;
}

interface State {
  readingEarlier: boolean;
  loading: boolean;
  error?: { cursor: string; message: string };
}

interface ScrollAnchor {
  message: Element;
  offset: number;
}

/** A line near the bottom edge of the visible conversation, and its distance above that edge. */
interface BottomAnchor { element: Element; offset: number }

// Capture the visible message immediately before React changes the DOM. A
// reader can keep scrolling while an IPC request (or another pane's request)
// is in flight, so its offset at request time would be stale.
export class ConversationTranscript extends Component<Props, State, ScrollAnchor | null> {
  state: State = { readingEarlier: false, loading: false };
  private area = createRef<HTMLDivElement>();
  private viewport = createRef<HTMLDivElement>();
  private followLatest = true;
  private lastScrollTop = 0;
  private loading = false;
  private mounted = false;
  private resize?: ResizeObserver;
  private observedContent?: Element | null;
  private observedDock?: HTMLElement | null;
  private bottomAnchor?: BottomAnchor;
  // Only the reader's own scrolling (wheel, touch, keys, scrollbar) leaves the
  // latest message; zoom, window and input box changes never do.
  private intentAt = -Infinity;
  private pointerHeld = false;
  private pointerAt = -Infinity;

  componentDidMount() {
    this.mounted = true;
    this.scrollToLatest();
    this.props.onFollowLatest(true);
    const viewport = this.viewport.current;
    if (viewport) {
      // The viewport (window, zoom, input box, panels) or its content (images,
      // expanded blocks) changed size: keep the latest message, or the line
      // being read at the bottom edge, where it was. The border box: the
      // padding kept under the input area is not a resize.
      this.resize = new ResizeObserver(entries => {
        const viewChanged = entries.some(entry => entry.target === viewport || entry.target === this.observedDock);
        if (viewChanged) this.fitDock();
        this.keepPosition(viewChanged);
      });
      this.resize.observe(viewport, { box: "border-box" });
      this.observeContent();
      this.observeDock();
    }
    window.addEventListener("pointerup", this.releasePointer);
    window.addEventListener("pointercancel", this.releasePointer);
  }

  componentWillUnmount() {
    this.mounted = false;
    this.resize?.disconnect();
    window.removeEventListener("pointerup", this.releasePointer);
    window.removeEventListener("pointercancel", this.releasePointer);
  }

  private releasePointer = () => { this.pointerHeld = false; };
  private noteIntent = () => { this.intentAt = performance.now(); };
  // A press on the scrollbar may end without a pointerup reaching the page.
  private get userScrolling() {
    const now = performance.now();
    return (this.pointerHeld && now - this.pointerAt < 30_000) || now - this.intentAt < 700;
  }

  private observeContent() {
    const content = this.viewport.current?.firstElementChild;
    if (content === this.observedContent) return;
    if (this.observedContent) this.resize?.unobserve(this.observedContent);
    this.observedContent = content;
    if (content) this.resize?.observe(content);
  }

  private observeDock() {
    const dock = this.props.dock ?? null;
    if (dock === this.observedDock || !this.resize) return;
    if (this.observedDock) this.resize.unobserve(this.observedDock);
    this.observedDock = dock;
    if (dock) this.resize.observe(dock, { box: "border-box" });
    else this.fitDock();
  }

  /** Room under the last message for the input area (and the jump button above it). */
  private fitDock() {
    const area = this.area.current, viewport = this.viewport.current;
    if (!area || !viewport) return;
    const box = viewport.getBoundingClientRect();
    const inset = Math.max(0, box.bottom - this.visibleBottom(box));
    area.style.setProperty("--dock-inset", `${inset}px`);
  }

  /** The bottom edge of the visible conversation: the top of the input area floating over it. */
  private visibleBottom(box: DOMRect) {
    const dock = this.observedDock;
    return dock?.isConnected ? Math.max(box.top, Math.min(box.bottom, dock.getBoundingClientRect().top)) : box.bottom;
  }

  /** A wheel over the input area scrolls the conversation, unless what is under
   * the pointer scrolls by itself (a long draft, a question, the terminal). */
  wheelFromDock = (event: WheelEvent) => {
    const viewport = this.viewport.current, dock = this.observedDock;
    if (!viewport || !dock || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    for (let element = event.target instanceof Element ? event.target : null; element && element !== dock; element = element.parentElement) {
      const style = getComputedStyle(element);
      // A dialog over the window (the rewind picker), or a box with its own scrolling.
      if (style.position === "fixed" || (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1)) return;
    }
    this.noteIntent();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
    viewport.scrollTop += event.deltaY * unit;
    if (event.deltaY < 0 && viewport.scrollTop <= 0) void this.loadEarlier();
  };

  private keepPosition(viewportResized: boolean) {
    const viewport = this.viewport.current;
    if (!viewport) return;
    // The reader opened a block (a click or key just now): it unfolds downwards
    // where it is, and the latest message may leave the view.
    if (this.followLatest && !viewportResized && this.userScrolling) {
      this.onScroll();
      return;
    }
    if (this.followLatest) viewport.scrollTop = viewport.scrollHeight;
    else if (this.bottomAnchor?.element.isConnected) {
      const now = this.bottomAnchor.element.getBoundingClientRect().top - this.visibleBottom(viewport.getBoundingClientRect());
      viewport.scrollTop += now - this.bottomAnchor.offset;
    }
    this.lastScrollTop = viewport.scrollTop;
    this.recordBottom();
  }

  /** Remember the block at the bottom edge while reading older messages. */
  private recordBottom() {
    const viewport = this.viewport.current;
    if (!viewport || this.followLatest) { this.bottomAnchor = undefined; return; }
    const box = viewport.getBoundingClientRect();
    const bottom = this.visibleBottom(box);
    if (bottom <= box.top) return;
    let element = document.elementFromPoint(box.left + box.width / 2, bottom - 6);
    if (!element || element === viewport || !viewport.contains(element)) {
      const messages = [...viewport.getElementsByClassName("message")];
      element = messages.filter(message => message.getBoundingClientRect().top < bottom).at(-1) ?? null;
    }
    while (element && element.parentElement && element.parentElement !== viewport && getComputedStyle(element).display.startsWith("inline"))
      element = element.parentElement;
    this.bottomAnchor = element ? { element, offset: element.getBoundingClientRect().top - bottom } : undefined;
  }

  getSnapshotBeforeUpdate(previous: Props, previousState: State): ScrollAnchor | null {
    const viewport = this.viewport.current;
    if (!viewport || this.followLatest ||
      (previous.messages === this.props.messages && previous.replyDetail === this.props.replyDetail && previousState.error === this.state.error)) return null;
    const messages = viewport.getElementsByClassName("message");
    const top = viewport.getBoundingClientRect().top;
    let first = 0;
    let end = messages.length;
    while (first < end) {
      const middle = Math.floor((first + end) / 2);
      if (messages[middle].getBoundingClientRect().bottom <= top) first = middle + 1;
      else end = middle;
    }
    const message = messages[first];
    return message ? { message, offset: message.getBoundingClientRect().top - top } : null;
  }

  componentDidUpdate(previous: Props, previousState: State, anchor?: ScrollAnchor | null) {
    this.observeDock();
    const viewport = this.viewport.current;
    if (!viewport || (previous.messages === this.props.messages && previous.replyDetail === this.props.replyDetail && previousState.error === this.state.error)) return;
    this.observeContent();
    if (this.followLatest) viewport.scrollTop = viewport.scrollHeight;
    else if (anchor?.message.isConnected) {
      const offset = anchor.message.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTop += offset - anchor.offset;
    }
    this.lastScrollTop = viewport.scrollTop;
    this.recordBottom();
  }

  scrollToLatest = () => {
    const viewport = this.viewport.current;
    if (!this.followLatest) this.props.onFollowLatest(true);
    this.followLatest = true;
    if (this.state.readingEarlier) this.setState({ readingEarlier: false });
    this.bottomAnchor = undefined;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      this.lastScrollTop = viewport.scrollTop;
    }
  };

  private loadEarlier = async () => {
    const page = this.props.historyPage;
    if (this.loading || !page?.hasOlder) return;
    this.loading = true;
    if (this.followLatest) this.props.onFollowLatest(false);
    this.followLatest = false;
    this.setState({ loading: true, readingEarlier: true, error: undefined });
    try {
      await this.props.loadEarlier(page.cursor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.mounted) this.setState({ error: { cursor: page.cursor, message } });
    } finally {
      this.loading = false;
      if (this.mounted) this.setState({ loading: false });
    }
  };

  private onScroll = () => {
    const viewport = this.viewport.current;
    if (!viewport) return;
    const top = viewport.scrollTop;
    const upwards = top < this.lastScrollTop;
    this.lastScrollTop = top;
    const readingEarlier = viewport.scrollHeight - top - viewport.clientHeight > 2;
    // A scroll the reader did not make (zoom, a resized window or input box,
    // the browser restoring an offset) keeps the latest message in view.
    if (readingEarlier && this.followLatest && !this.userScrolling) {
      viewport.scrollTop = viewport.scrollHeight;
      this.lastScrollTop = viewport.scrollTop;
      return;
    }
    if (this.followLatest !== !readingEarlier) this.props.onFollowLatest(!readingEarlier);
    this.followLatest = !readingEarlier;
    if (this.state.readingEarlier !== readingEarlier) this.setState({ readingEarlier });
    this.recordBottom();
    if (upwards && top < 120) void this.loadEarlier();
  };

  private openPath = (path: string) => this.props.openArtifact({ path });
  private openAttachment = (attachment: MessageAttachment) =>
    this.props.openArtifact(attachment.path ? { path: attachment.path } : { attachment });

  render() {
    const { workspace, messages, historyPage, children } = this.props;
    const cwd = workspace?.cwd ?? "";
    const error = this.state.error?.cursor === historyPage?.cursor ? this.state.error?.message : undefined;
    return (
      <div className="transcript-area" ref={this.area}>
        <div className="conversation-scroll" ref={this.viewport} onScroll={this.onScroll}
          role="region" aria-label={t('composer.messages')} tabIndex={0}
          onPointerDown={() => { this.pointerHeld = true; this.pointerAt = performance.now(); this.noteIntent(); }}
          onTouchMove={this.noteIntent}
          onKeyDown={event => {
            // Keys here scroll or open blocks; typing happens in the input box.
            this.noteIntent();
            if (historyPage?.hasOlder && event.target === event.currentTarget && event.currentTarget.scrollTop <= 0 &&
              (event.key === "PageUp" || event.key === "ArrowUp")) {
              event.preventDefault();
              if (!event.repeat) void this.loadEarlier();
            }
          }}
          onWheel={event => {
            this.noteIntent();
            if (event.deltaY < 0 && event.currentTarget.scrollTop <= 0) void this.loadEarlier();
          }}>
          {messages?.length || this.props.tasks?.length || historyPage?.hasOlder ? <div className="conversation">
            <div className="conversation-intro">
              <span>{workspace?.kind === "ssh" ? <Server size={12} /> : <Laptop size={12} />}
                {workspace?.kind === "ssh" ? workspace.host : t('workbench.local')}</span>
              <span className="intro-dot">·</span>
              <span title={cwd}>{cwd.length > 35 ? `…${cwd.slice(-34)}` : cwd}</span>
            </div>
            {historyPage?.hasOlder && <div className="history-page-control" aria-busy={this.state.loading}>
              <button type="button" aria-disabled={this.state.loading} onClick={() => void this.loadEarlier()}>
                <ArrowUp size={14} aria-hidden="true" />
                {t(this.state.loading ? 'composer.loadingEarlier' : error ? 'composer.retryEarlier' : 'composer.loadEarlier')}
              </button>
              {error && <span className="history-page-error" role="alert">{error}</span>}
            </div>}
            <ArtifactReferenceScope workspace={workspace} sessionId={this.props.sessionId}>
              {messages?.map(message => <MessageDisplay key={message.id} message={message} replyDetail={this.props.replyDetail}
                onOpenPath={this.openPath} onOpenAttachment={this.openAttachment} onRewind={this.props.onRewind} onQuote={this.props.onQuote} />)}
            </ArtifactReferenceScope>
            <ConversationTaskList tasks={this.props.tasks} />
            <div className="conversation-end" />
          </div> : children}
        </div>
        {this.props.overlay}
        {this.state.readingEarlier && !!messages?.length && <button type="button" className="scroll-latest" aria-label={t('composer.scrollLatest')}
          onClick={this.scrollToLatest}><ArrowDown size={16} />{t('composer.latest')}</button>}
      </div>
    );
  }
}
