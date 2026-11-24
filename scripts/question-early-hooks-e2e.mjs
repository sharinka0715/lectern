// npm run build && node scripts/question-early-hooks-e2e.mjs [packaged-executable]
// question-early-e2e with Settings → Session's recording hooks on (scripts/fixtures/dialog-hooks.mjs).
process.env.LECTERN_E2E_DIALOG_HOOKS = '1';
await import('./question-early-e2e.mjs');
