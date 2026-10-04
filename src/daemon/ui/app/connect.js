// Connect a machine, and the key shown once after creating or replacing one.

VIEWS.connect = () => html`
  ${pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: 'Connect a machine' })}
  <div class="readable">
    <p>On the machine, after installing agentio, run this and approve the code it shows. Nothing to copy back.</p>
    ${command(loginCommand(location.origin))}
    <details id="by-hand" class="mt-24" ${state.ui.byHand ? raw('open') : ''}>
      <summary class="button link">Advanced: create a key by hand</summary>
      <form class="mt-16" data-submit="create-key" novalidate>
        <label class="form-field"><span class="label">Name</span>
          <input class="input mono" type="text" name="name" id="key-name" placeholder="e.g. laptop, ci, build-box" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="key-name-error">
          <span class="help">How you will recognise this machine.</span></label>
        <span id="key-name-error" class="field-error" role="alert" hidden></span>
        <fieldset class="plain"><legend class="label">What it can use</legend>${accessChooser('create')}</fieldset>
        <div class="actions"><a class="button" href="#machines">Cancel</a><button class="button primary">Create key</button></div>
      </form>
    </details>
  </div>`;

SUBMITS['create-key'] = async (form) => {
  const field = form.elements.name;
  const name = field.value.trim();
  const err = $('key-name-error');
  err.hidden = true;
  field.removeAttribute('aria-invalid');
  if (!name) {
    err.textContent = '✗ Give the machine a name.';
    err.hidden = false;
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    return;
  }
  let input;
  try {
    input = presetInput(readAccessChoice(form, 'create'), name);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const button = form.querySelector('.button.primary');
  button.disabled = true;
  button.textContent = 'Creating…';
  const res = await api('/ui/api/keys', { method: 'POST', body: JSON.stringify({ ...input, url: location.origin }) });
  if (res.lost) return;
  if (!res.ok) { button.disabled = false; button.textContent = 'Create key'; toast(res.error, 'error'); return; }
  state.keys = [...state.keys, res.body.key];
  state.ui.byHand = false;
  showKey(res.body.key, res.body.token, 'created');
};

/** Opens the shown-once page. The key lives in memory only, and only until the owner leaves the page. */
function showKey(key, token, how) {
  state.ui.shownKey = { id: key.id, name: key.name, token, how, copied: false };
  go({ view: 'key' });
}

VIEWS.key = () => {
  const shown = state.ui.shownKey;
  if (!shown) {
    return systemPage({ title: 'Nothing to show', why: 'A key is shown only once, right after it is created or replaced.', action: html`<a class="button" href="#machines">Back to machines</a>` });
  }
  const quoted = shellQuote(shown.token);
  const save = `(umask 077 && mkdir -p ~/.config/agentio && printf '%s\\n' ${quoted} > ~/.config/agentio/token)`;
  const env = `export AGENTIO_TOKEN=${quoted}`;
  return html`
    ${pageHead({ path: [{ href: '#machines', label: 'Machines' }, { href: routeHash({ view: 'machine', id: shown.id }), label: shown.name }], title: shown.how === 'replaced' ? 'Key replaced' : 'Key created' })}
    <div class="readable">
      <p><b>This key is shown once.</b> If it is lost, replace it. On ${shown.name}, after installing agentio, run one of these.</p>
      <h2>Save it for this user</h2>${command(save)}
      <h2>Or for one shell or a CI job</h2>${command(env)}
      <div class="actions"><button class="button primary" data-action="key-done">Done</button></div>
    </div>`;
};

ACTIONS['key-done'] = () => go({ view: 'machine', id: state.ui.shownKey ? state.ui.shownKey.id : '' });
