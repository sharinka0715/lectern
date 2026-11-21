import type { Namespace } from './types';

/** The sample folder and conversation of `npm run demo` (src/main/demo.ts). */
export const demo = {
  folder: ['产品工作室', 'Product Studio'],
  title: ['让远端会话，回到桌面', 'Remote sessions, back on your desktop'],
  question: ['我想在桌面上继续远端的 Claude Code 会话。', 'I want to continue my remote Claude Code sessions on the desktop.'],
  answer: ['可以。你的工作仍在原来的机器上，Lectern 为它提供一个安静、熟悉的对话窗口。\n\n- **直接连接**：通过 SSH 操作原版 Claude Code\n- **实时可见**：从 tmux 画面捕获正在生成的回复\n- **自然续接**：JSONL 落盘后，在同一气泡补全正文\n\n这是一个离线演示。试着发送「你好」，观察实时预览如何变成正式回复。', 'Sure. Your work stays on its machine; Lectern gives it a calm, familiar chat window.\n\n- **Direct**: drive the original Claude Code over SSH\n- **Live**: replies appear from the tmux screen while they are written\n- **Seamless**: once the JSONL is saved, the same bubble fills in the final text\n\nThis is an offline demo. Send "hello" and watch the live preview turn into the final reply.'],
} as const satisfies Namespace;
