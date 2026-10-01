// Boot: delegated listeners, routing, and the first session probe.

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  ev.preventDefault();
  ACTIONS[el.dataset.action](el, ev);
});

document.addEventListener('change', (ev) => {
  // A profile checkbox, the "Read-only" box, or the "Same as…" <select> lives inside its
  // own option's <label class="radio">, alongside the actual radio input. Changing one of
  // those should select that option too, not just the radio the owner happened to click.
  const radio = ev.target.closest('.radio');
  if (radio) {
    const own = radio.querySelector(':scope > input[type=radio]');
    if (own) own.checked = true;
  }
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
  // The overview never tests profiles itself, but a sign-in started elsewhere
  // while the owner was on another tab should still show up without a reload.
  if (currentRoute().view === 'overview') loadPending().then(render);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.loaded) return;
  if (currentRoute().view === 'overview') loadPending().then(render);
});

(async () => {
  const res = await api('/ui/api/session');
  if (res.ok && res.body.authenticated && !res.body.locked) await openHub();
  else if (!res.lost) showUnlock(res.ok ? res.body.locked : true);
})();
