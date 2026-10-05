// Boot: delegated listeners, routing, and the first session probe.

// Inside AgentIO Companion the app's bridge exists before this script runs: the page leaves room for the window's buttons.
if (window.agentioCompanion?.present === true) document.documentElement.classList.add('app');

// The app's web view ignores app-region: pressing an empty part of the sidebar, a header, or
// the gate's background asks the app to move its window. Controls keep their clicks.
const WINDOW_CONTROLS = 'a, button, input, select, textarea, label, summary, [data-action], [role="button"]';
document.addEventListener('mousedown', (ev) => {
  if (!document.documentElement.classList.contains('app') || ev.button !== 0 || ev.detail > 1) return;
  const target = ev.target;
  if (target.closest(WINDOW_CONTROLS)) return;
  if (!target.closest('.sidebar, .pane-head') && !target.matches('.shell.bare > #main')) return;
  window.agentioCompanion.dragWindow?.();
});

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
  // The box is in the list pane, which a narrow window hides once a row is open.
  if (!box || !box.offsetParent) return;
  ev.preventDefault();
  box.focus();
  box.select();
});

// The list pane's scroll lives in state, so render() can put it back even after a narrow window hid the pane.
$('list').addEventListener('scroll', () => {
  const list = $('list');
  if (!list.dataset.list) return;
  state.ui.listScroll[list.dataset.list] = list.scrollTop;
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-submit]');
  if (!form || !SUBMITS[form.dataset.submit]) return;
  ev.preventDefault();
  SUBMITS[form.dataset.submit](form, ev);
});

// AgentIO Companion added a profile: show it. The detail comes from the app, not from a person.
window.addEventListener('agentio:profiles-changed', async (ev) => {
  const { service, profile } = ev.detail ?? {};
  if (!(await loadAll())) return;
  location.hash = typeof service === 'string' && typeof profile === 'string'
    ? routeHash({ view: 'profile', ref: `${service}/${profile}` })
    : '#profiles';
  render();
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
      const leave = await confirmDialog(LEAVE_KEY);
      leavePrompt = false;
      if (!leave) return;
      state.ui.shownKey = null;
      location.hash = target;
      return;
    }
    state.ui.shownKey = null;
  }
  lastHash = location.hash;
  state.ui.renaming = null;
  state.ui.renameError = '';
  state.ui.renameDraft = undefined;
  state.ui.byHand = false;
  state.ui.editScope = null;
  clearToasts();
  render();
  // A new page starts at the top of the details. Focus moves to it for screen readers, without scrolling.
  main.scrollTo(0, 0);
  main.focus({ preventScroll: true });
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
