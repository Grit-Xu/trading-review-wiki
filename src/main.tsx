// Global error display - runs before anything else
const errDiv = document.createElement('div')
errDiv.id = 'fatal-error'
errDiv.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0a0a0a;color:#e5e5e5;font-family:monospace;font-size:12px;z-index:99999;overflow:auto;padding:20px;white-space:pre-wrap;'
document.body.appendChild(errDiv)

function showFatal(title: string, msg: string, stack?: string) {
  errDiv.style.display = 'block'
  errDiv.textContent = title + '\n\n' + msg + '\n\n' + (stack || '')
}

window.addEventListener('error', (e) => {
  showFatal('GLOBAL ERROR', e.error?.message || e.message || String(e.error), e.error?.stack)
})

window.addEventListener('unhandledrejection', (e) => {
  showFatal('UNHANDLED REJECTION', e.reason?.message || String(e.reason), e.reason?.stack)
})

// Patch console.error to intercept React errors
const origError = console.error
console.error = function(...args: unknown[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  if (msg.includes('trim') || msg.includes('Something went wrong') || msg.includes('Error:')) {
    showFatal('CONSOLE ERROR', msg, '')
  }
  origError.apply(console, args)
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { ErrorBoundary } from "@/components/error-boundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
