// Boot: delegated listeners, routing, and the first session probe.

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  ev.preventDefault();
  ACTIONS[el.dataset.action](el, ev);
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, ev);
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-submit]');
  if (!form || !SUBMITS[form.dataset.submit]) return;
  ev.preventDefault();
  SUBMITS[form.dataset.submit](form, ev);
});

window.addEventListener('hashchange', () => {
  clearToasts();
  render();
  main.focus();
});

(async () => {
  const res = await api('/ui/api/session');
  if (res.ok && res.body.authenticated && !res.body.locked) await openHub();
  else if (!res.lost) showUnlock();
})();
