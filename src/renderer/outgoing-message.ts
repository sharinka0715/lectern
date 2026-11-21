import type { ChatMessage } from "../shared/types";

/**
 * A chat message the user just sent, shown at once while the main process
 * types it into the native pane (a few SSH round trips). It is display-only:
 * the controller's own bubble replaces it as soon as the send is confirmed,
 * and a failed send removes it and puts the text back into the composer.
 */
export interface OutgoingMessage {
  id: string;
  /** `${workspaceId}:${sessionId}` the message was sent to. */
  scope: string;
  text: string;
  /** User message IDs present when the user pressed Enter. */
  before: ReadonlySet<string>;
}

/** Slash commands print into the terminal and never become a chat bubble. */
export function showsOutgoing(text: string): boolean {
  return !!text.trim() && !text.trimStart().startsWith("/");
}

export function startOutgoing(scope: string, text: string, messages: ChatMessage[] | undefined, id: string): OutgoingMessage {
  return { id, scope, text, before: new Set((messages ?? []).filter(message => message.role === "user").map(message => message.id)) };
}

/** True once the controller shows this message itself (optimistic or saved). */
export function outgoingDelivered(messages: ChatMessage[] | undefined, outgoing: OutgoingMessage): boolean {
  const text = outgoing.text.trim();
  return (messages ?? []).some(message => message.role === "user" && !outgoing.before.has(message.id) && message.text.trim() === text);
}

export function withOutgoing(messages: ChatMessage[] | undefined, scope: string, outgoing?: OutgoingMessage): ChatMessage[] | undefined {
  if (!messages || !outgoing || outgoing.scope !== scope || outgoingDelivered(messages, outgoing)) return messages;
  return [...messages, { id: outgoing.id, role: "user", text: outgoing.text, tools: [], source: "pending", status: "complete" }];
}
