/**
 * react-app.jsx — E2E fixture: a small React 19 app used both client-rendered (react.html) and
 * server-rendered + hydrated (/react-ssr.html). Verifies the extension does not break React
 * reconciliation/hydration and that replacements survive re-renders.
 */
import React, { useState } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

/** Demo component: counter text, list add/remove, uncontrolled input. */
export function App() {
  const [n, setN] = useState(0);
  const [items, setItems] = useState(['apple one', 'banana two']);
  return (
    <div>
      <h2 id="r-title">Apple #{n}</h2>
      <p id="r-text">{`Your apple count is ${n}`}</p>
      <button id="r-inc" onClick={() => setN(n + 1)}>
        Next apple
      </button>
      <button id="r-add" onClick={() => setItems([...items, `apple ${items.length + 1}`])}>
        add
      </button>
      <button id="r-remove" onClick={() => setItems(items.slice(1))}>
        remove
      </button>
      <ul id="r-list">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <input id="r-input" placeholder="type apple" defaultValue="apple typed" />
    </div>
  );
}

if (typeof document !== 'undefined') {
  window.__pageErrors = [];
  window.__recoverable = 0;
  window.addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
  const el = document.getElementById('root');
  if (el.dataset.ssr) {
    hydrateRoot(el, <App />, { onRecoverableError: () => (window.__recoverable += 1) });
  } else {
    createRoot(el).render(<App />);
  }
  window.__reactReady = true;
}
