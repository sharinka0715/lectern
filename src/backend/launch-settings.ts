/** The per-process settings (`claude --settings <json>`) every Claude that Lectern
 * starts gets: new chats, resumes, the temporary resume behind a rename and the
 * model-list probe. They layer over the user's own settings files for this process
 * only; those files are never written. */
export function launchSettings(options: { statusLine?: object; enableWorkflows: boolean }): Record<string, unknown> {
  return {
    ...options.statusLine,
    // A prompt suggestion fills the empty composer with grey text, which reads
    // as an unsent native draft and blocks chat input.
    promptSuggestionEnabled: false,
    // Pro plans start with dynamic workflows off, which hides /effort's Ultracode.
    ...(options.enableWorkflows && { enableWorkflows: true }),
    // Sessions start in auto mode. As the default mode (rather than
    // `--permission-mode auto`) it also keeps Claude Code 2.1.300+ from asking a
    // user whose own default is manual "Make auto mode your default permission
    // mode?" before the first message. Where auto mode is unavailable (turned off
    // with permissions.disableAutoMode in user, project or managed settings)
    // Claude Code starts in manual mode and tool permissions show as cards.
    permissions: { defaultMode: 'auto' },
    // No `env`: auto mode's safety check stays where Claude Code puts it (on the
    // server, free of charge, with a direct Anthropic connection). Through a gateway
    // that does not pass it through, Claude Code says so in a dialog (the billing
    // notice in 2.1.300–2.1.310, "Auto mode can't check actions" from 2.1.321), which
    // Lectern shows as a card (core/auto-mode-screen.ts). A user who wants the local
    // check sets CLAUDE_CODE_AUTO_MODE_SERVER=0 in their shell or settings themselves.
  };
}
