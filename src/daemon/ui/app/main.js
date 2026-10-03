// Boot: delegated listeners, routing, and the first session probe.

// The gate dialog is the only way back in: Esc must not close it over a dead session.
$('gate-dialog').addEventListener('cancel', (ev) => ev.preventDefault());

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  ev.preventDefault();
  ACTIONS[el.dataset.action](el, ev);
});

document.addEventListener('change', (ev) => {
  // A profile checkbox, the "Read-only" box, or the "Same as…" <select> lives inside its
  // own option's <label class="radio-card">, alongside the actual radio input. Changing one of
  // those should select that option too, not just the radio the owner happened to click.
  const radio = ev.target.closest('.radio-card');
  if (radio) {
    const own = radio.querySelector(':scope > input[type=radio]');
    if (own) own.checked = true;
  }
  const el = ev.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, ev);
});

document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-input]');
  if (el && INPUTS[el.dataset.input]) INPUTS[el.dataset.input](el, ev);
});

// "/" jumps to the filter box, unless the owner is already typing somewhere.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && ev.target.id === 'rename-input') { ev.preventDefault(); ACTIONS['cancel-rename'](); return; }
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const target = ev.target;
  if (target.closest('input, textarea, select, [contenteditable]')) return;
  const box = $('profile-filter');
  if (!box) return;
  ev.preventDefault();
  box.focus();
  box.select();
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-submit]');
  if (!form || !SUBMITS[form.dataset.submit]) return;
  ev.preventDefault();
  SUBMITS[form.dataset.submit](form, ev);
});

ACTIONS['toggle-menu'] = () => {
  const open = $('tabs').classList.toggle('open');
  $('menu-button').setAttribute('aria-expanded', String(open));
};

function closeMenu() {
  $('tabs').classList.remove('open');
  $('menu-button').setAttribute('aria-expanded', 'false');
}

// A same-tab tap on a menu link does not fire hashchange: close the menu on the tap.
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#tabs a')) closeMenu();
});

let lastHash = location.hash;
let leavePrompt = false;

window.addEventListener('hashchange', async () => {
  // The leave prompt is open: a further move only puts the key page back.
  if (leavePrompt) {
    history.replaceState(null, '', lastHash);
    return;
  }
  // Leaving the shown-once key before copying it asks first; once left, the key is forgotten.
  const leavingKey = parseRoute(lastHash).view === 'key' && currentRoute().view !== 'key';
  if (leavingKey && state.ui.shownKey) {
    if (!state.ui.shownKey.copied) {
      const target = location.hash;
      history.replaceState(null, '', lastHash);
      leavePrompt = true;
      const leave = await confirmDialog({
        title: 'Leave without copying the key?',
        body: "It isn't shown again. If you leave now, you'll have to replace the key.",
        action: 'Leave',
      });
      leavePrompt = false;
      if (!leave) return;
      state.ui.shownKey = null;
      location.hash = target;
      return;
    }
    state.ui.shownKey = null;
  }
  lastHash = location.hash;
  closeMenu();
  state.ui.renaming = null;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  clearToasts();
  render();
  main.focus();
  // Tests stay on demand, but a sign-in started elsewhere should show up
  // in the banner without a reload: refresh the waiting list on every move.
  if (state.loaded) loadPending().then(render);
});

window.addEventListener('beforeunload', (ev) => {
  if (state.ui.shownKey && !state.ui.shownKey.copied) { ev.preventDefault(); ev.returnValue = ''; }
});

// <details> does not bubble its toggle: remember "create a key by hand" being open across redraws.
document.addEventListener('toggle', (ev) => {
  if (ev.target.id === 'by-hand') state.ui.byHand = ev.target.open;
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.loaded) return;
  loadAll().then((ok) => { if (ok && !formOpen()) render(); });
});

(async () => {
  const res = await api('/ui/api/session');
  if (res.status === 0) showUnreachable();
  else if (res.ok && res.body.authenticated && !res.body.locked) await openHub();
  else if (!res.lost) showUnlock(res.ok ? res.body.locked : true);
})();
