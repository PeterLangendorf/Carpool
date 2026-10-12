// The app's own pop-ups, used instead of the browser's confirm() and prompt()
// boxes: a sheet in the same style as the app's other overlays, with a title,
// a message, optionally a list or a text box, and two buttons. Both return
// promises. Loaded as a plain <script>; defines `Dialog`.
/* exported Dialog */
const Dialog = (() => {
  let overlay;
  let titleEl;
  let messageEl;
  let listEl;
  let fieldEl;
  let labelEl;
  let inputEl;
  let okBtn;
  let cancelBtn;
  let resolve = null;
  let returnFocus = null;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'overlay dialog-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'dialogTitle');
    overlay.innerHTML = `
      <form class="overlay-card dialog-card" novalidate>
        <h2 id="dialogTitle"></h2>
        <div class="dialog-message"></div>
        <ul class="dialog-list hidden"></ul>
        <div class="field dialog-field hidden">
          <label for="dialogInput"></label>
          <input type="text" id="dialogInput" autocomplete="off" />
        </div>
        <div class="confirm-actions">
          <button type="button" class="ghost" data-dialog="cancel"></button>
          <button type="submit" data-dialog="ok"></button>
        </div>
      </form>`;
    titleEl = overlay.querySelector('h2');
    messageEl = overlay.querySelector('.dialog-message');
    listEl = overlay.querySelector('.dialog-list');
    fieldEl = overlay.querySelector('.dialog-field');
    labelEl = fieldEl.querySelector('label');
    inputEl = fieldEl.querySelector('input');
    okBtn = overlay.querySelector('[data-dialog="ok"]');
    cancelBtn = overlay.querySelector('[data-dialog="cancel"]');

    // OK is the form's submit, so Enter in the text box confirms.
    overlay.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!fieldEl.classList.contains('hidden') && !inputEl.value.trim()) {
        inputEl.focus();
        return;
      }
      finish(true);
    });
    cancelBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    document.body.appendChild(overlay);
  }

  function finish(confirmed) {
    if (!resolve) return;
    const done = resolve;
    resolve = null;
    overlay.classList.add('hidden');
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
    done(confirmed);
  }

  // `message` may hold several paragraphs separated by blank lines; `items`
  // is an optional list shown under it. All text, never HTML.
  function open({ title, message = '', items = [], confirmText = 'OK', cancelText = 'Cancel', danger = false, input = null }) {
    if (!overlay) build();
    if (resolve) finish(false); // only one at a time

    titleEl.textContent = title;
    messageEl.replaceChildren(
      ...String(message)
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((text) => {
          const p = document.createElement('p');
          p.className = 'subtitle';
          p.textContent = text.trim();
          return p;
        })
    );
    listEl.replaceChildren(
      ...items.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      })
    );
    listEl.classList.toggle('hidden', !items.length);
    fieldEl.classList.toggle('hidden', !input);
    if (input) {
      labelEl.textContent = input.label || '';
      inputEl.placeholder = input.placeholder || '';
      inputEl.value = input.value || '';
    }
    okBtn.textContent = confirmText;
    okBtn.className = danger ? 'danger-btn' : '';
    cancelBtn.textContent = cancelText;

    returnFocus = document.activeElement;
    overlay.classList.remove('hidden');
    (input ? inputEl : okBtn).focus();
    return new Promise((r) => {
      resolve = r;
    });
  }

  // Resolves to true for the confirm button, false otherwise.
  function confirm(options) {
    return open(options);
  }

  // Resolves to the trimmed text entered, or null if cancelled.
  async function prompt({ label, placeholder, value, ...options }) {
    const confirmed = await open({ ...options, input: { label, placeholder, value } });
    return confirmed ? inputEl.value.trim() : null;
  }

  return { confirm, prompt };
})();
