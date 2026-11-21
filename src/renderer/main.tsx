import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installRendererDiagnostics } from "./diagnostics";
import { applyLocale, useLocale } from "./i18n";
import { systemLocale } from "../shared/i18n";
import "./styles.css";

installRendererDiagnostics();

/** Re-renders the whole workbench in place (state kept) when the language changes. */
function Root() {
  useLocale();
  return <App />;
}

async function start() {
  // The main process owns the language (Settings, LECTERN_LOCALE, the OS); take
  // it before the first render so nothing flashes in the other language.
  try {
    applyLocale(window.desktop ? (await window.desktop.localeState()).locale : systemLocale(navigator.languages));
    window.desktop?.onLocaleChange(state => applyLocale(state.locale));
  } catch { /* Keep the default language. */ }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
void start();
