// Panel document script (plain JS: it runs in the page, not in the preload).
// Inline handlers are what the panel's CSP exists to forbid, so the buttons
// declare their action and this wires it to the panel bridge.
for (const el of document.querySelectorAll('[data-detect-action]')) {
  el.addEventListener('click', () => window.detect.action(el.dataset.detectAction))
}
