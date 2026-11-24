// npm run build && node scripts/permission-hooks-e2e.mjs [packaged-executable]
// permission-ui-e2e with Settings → Session's recording hooks on (scripts/fixtures/dialog-hooks.mjs).
process.env.LECTERN_E2E_DIALOG_HOOKS = '1';
await import('./permission-ui-e2e.mjs');
