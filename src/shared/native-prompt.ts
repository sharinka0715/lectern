/**
 * The text Claude Code records for a prompt pasted into its input box. Its paste
 * handler (2.1.300–2.1.330) turns CR and CRLF into LF and every tab into four spaces, so
 * "a\tb" sent from the chat is saved as "a    b". Outer whitespace is not part of
 * the prompt. Other whitespace counts: different prompts are never conflated.
 */
export function nativePromptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').trim();
}

/** A chat send and the user record Claude Code saved for it. */
export function samePrompt(sent: string, recorded: string): boolean {
  return nativePromptText(sent) === nativePromptText(recorded);
}
