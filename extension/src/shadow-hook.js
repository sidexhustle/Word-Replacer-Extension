/**
 * shadow-hook.js — Runs in the page's MAIN world at document_start (before any page script).
 *
 * Purpose: the isolated-world content script cannot see when a page attaches a NEW shadow root
 * to an element that is already in the document (e.g. a custom element upgraded after
 * customElements.define()). This hook wraps Element.prototype.attachShadow and, after the real
 * call, dispatches a bubbling + composed event from the host so content.js can find, observe and
 * process the new root (open or closed, via chrome.dom.openOrClosedShadowRoot).
 *
 * The wrapper is a Proxy around the native function, so `name`, `length` and
 * Function.prototype.toString() still report native code (avoids tripping bot-detection scripts).
 * Installing twice (e.g. re-injection after an extension reload) is a no-op.
 */
(() => {
  'use strict';

  const EVENT_NAME = 'wr:shadow-attached-v1';
  const DETACHED_EVENT_NAME = 'wr:shadow-attached-detached-v1';
  const MARK = Symbol.for('wr.shadowHook.v1');
  const proto = typeof Element === 'function' ? Element.prototype : null;
  const native = proto && proto.attachShadow;
  if (typeof native !== 'function' || native[MARK]) return;

  // Captured now so later page changes to these built-ins cannot interfere.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const isConnected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected').get;
  const doc = document;
  const EventCtor = Event;
  const MouseEventCtor = MouseEvent;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'attachShadow');

  /**
   * Notifies content.js about a new shadow root on `host`:
   *  - connected host: composed event from the host itself (listeners on the document and on
   *    already-known shadow roots receive the exact host);
   *  - detached host: event on the document carrying the host as relatedTarget, so content.js can
   *    remember it and find its (possibly closed) root once the host is inserted.
   */
  function notify(host) {
    if (Reflect.apply(isConnected, host, [])) {
      Reflect.apply(dispatch, host, [new EventCtor(EVENT_NAME, { bubbles: true, composed: true })]);
    } else {
      Reflect.apply(dispatch, doc, [new MouseEventCtor(DETACHED_EVENT_NAME, { relatedTarget: host })]);
    }
  }

  const hooked = new Proxy(native, {
    /** Calls the real attachShadow, then notifies the content script (never throws on its own). */
    apply(target, host, args) {
      const root = Reflect.apply(target, host, args);
      try {
        notify(host);
      } catch (_) {
        /* never break the page */
      }
      return root;
    },
    /** Exposes a private marker so a second injection can detect the existing hook. */
    get(target, prop, receiver) {
      return prop === MARK ? true : Reflect.get(target, prop, receiver);
    },
  });

  try {
    Object.defineProperty(proto, 'attachShadow', { ...descriptor, value: hooked });
  } catch (_) {
    /* frozen prototype: content.js still finds roots by walking the DOM */
  }
})();
