/**
 * lit-app.js — E2E fixture: a Lit web component (open shadow root, reactive re-render).
 */
import { LitElement, html } from 'lit';

/** <lit-greeting>: static text + a reactive counter rendered into its shadow root. */
class LitGreeting extends LitElement {
  static properties = { count: { type: Number } };

  constructor() {
    super();
    this.count = 0;
  }

  render() {
    return html`<p id="lit-p">Lit apple ${this.count}</p>
      <button id="lit-btn" @click=${() => this.count++}>more apple</button>`;
  }
}

customElements.define('lit-greeting', LitGreeting);
