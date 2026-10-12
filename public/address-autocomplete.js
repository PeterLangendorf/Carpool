// Address suggestions as you type, from Mapbox Address Autofill, for the
// app's address boxes. Picking a suggestion is recommended, not required:
// a typed address is still accepted (a brand-new house, an apartment number
// added on), the box just says it wasn't found. Only the text is ever saved;
// Mapbox's terms don't allow storing its coordinates.
//
// Suggestions come through our own GET /api/address-suggestions (see
// src/address-suggestions.js), so the Mapbox token stays on the server. If
// that isn't set up, the boxes stay plain text boxes. Loaded as a plain
// <script>; defines `AddressAutocomplete`.
/* exported AddressAutocomplete */
const AddressAutocomplete = (() => {
  const SUGGEST_URL = '/api/address-suggestions';
  const MIN_CHARS = 3;
  const DEBOUNCE_MS = 250;
  const NOTE_TEXT = "Not found on the map. If you can, pick an address from the list so drivers' map links go to the right place.";

  // Whether suggestions are set up (asked once per page).
  let availablePromise = null;
  function isAvailable() {
    if (!availablePromise) {
      availablePromise = fetch(SUGGEST_URL)
        .then((res) => res.ok)
        .catch(() => false);
    }
    return availablePromise;
  }

  // Per input: the text of the suggestion picked (null if none) and whether
  // suggestions are on (`enabled`, once the server says they're set up).
  const states = new WeakMap();

  function newSessionToken() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // True when the box holds exactly the suggestion that was picked (or a
  // saved address that was picked earlier; see setVerified).
  function isVerified(input) {
    const state = states.get(input);
    return Boolean(state && state.picked && state.picked === input.value.trim());
  }

  // For boxes filled in from saved data.
  function setVerified(input, verified) {
    const state = states.get(input);
    if (!state) return;
    state.picked = verified ? input.value.trim() : null;
    state.render();
  }

  // Adds suggestions to an <input>. `onPick` runs after one is picked.
  function attach(input, { onPick } = {}) {
    if (states.has(input)) return;
    const state = { picked: null, enabled: false, render: () => {} };
    states.set(input, state);

    isAvailable().then((available) => {
      if (!available) return;
      state.enabled = true;

      // Wrap the box so the list can sit right under it.
      const wrap = document.createElement('div');
      wrap.className = 'ac-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      // A small spinning circle at the box's right end, from when there's
      // enough typed to search until the suggestions come back.
      const loading = document.createElement('div');
      loading.className = 'ac-loading';
      loading.setAttribute('role', 'progressbar');
      loading.setAttribute('aria-label', 'Looking up addresses');
      loading.setAttribute('aria-hidden', 'true');
      wrap.appendChild(loading);
      const list = document.createElement('div');
      list.className = 'ac-list hidden';
      list.setAttribute('role', 'listbox');
      wrap.appendChild(list);
      const note = document.createElement('p');
      note.className = 'ac-note hidden';
      note.textContent = NOTE_TEXT;
      wrap.appendChild(note);
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('aria-autocomplete', 'list');

      let suggestions = [];
      let active = -1;
      let timer = null;
      let controller = null;
      let sessionToken = newSessionToken();

      state.render = () => {
        const verified = isVerified(input);
        input.classList.toggle('ac-verified', verified);
        note.classList.toggle('hidden', verified || !input.value.trim() || document.activeElement === input);
      };

      function setLoading(on) {
        // Centred on the box itself (the wrap can be taller than it).
        if (on) loading.style.top = `${input.offsetTop + input.offsetHeight / 2}px`;
        loading.classList.toggle('on', on);
        input.classList.toggle('ac-busy', on);
        loading.setAttribute('aria-hidden', String(!on));
        wrap.setAttribute('aria-busy', String(on));
      }

      // Hides the list and drops any lookup still in flight.
      function close() {
        list.classList.add('hidden');
        suggestions = [];
        active = -1;
        clearTimeout(timer);
        if (controller) controller.abort();
        setLoading(false);
      }

      function showList() {
        if (!suggestions.length) return close();
        list.innerHTML =
          suggestions
            .map((s, i) => `<div class="ac-option${i === active ? ' active' : ''}" role="option" data-index="${i}">${escapeHtml(s)}</div>`)
            .join('') + '<div class="ac-credit">Search by Mapbox</div>';
        list.classList.remove('hidden');
      }

      function pick(index) {
        const suggestion = suggestions[index];
        if (!suggestion) return;
        input.value = suggestion;
        state.picked = input.value;
        sessionToken = newSessionToken();
        close();
        state.render();
        // Let the page's own listeners see the new value.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (onPick) onPick(input.value);
      }

      async function fetchSuggestions(text) {
        if (controller) controller.abort();
        const mine = new AbortController();
        controller = mine;
        const params = new URLSearchParams({ q: text, session: sessionToken });
        try {
          const res = await fetch(`${SUGGEST_URL}?${params}`, { signal: mine.signal });
          if (!res.ok) return close();
          const data = await res.json();
          // They've typed on since, or left the box.
          if (input.value.trim() !== text || document.activeElement !== input) return;
          suggestions = (data.suggestions || []).filter((s) => typeof s === 'string' && s);
          active = -1;
          showList();
        } catch {
          // Aborted by newer typing, or offline: keep it a plain box.
        } finally {
          if (controller === mine) setLoading(false);
        }
      }

      input.addEventListener('input', (e) => {
        state.render();
        if (!e.isTrusted) return; // our own event after a pick
        clearTimeout(timer);
        const text = input.value.trim();
        if (text.length < MIN_CHARS) return close();
        // Drop the lookup for what was typed before; this one replaces it.
        if (controller) controller.abort();
        controller = null;
        setLoading(true);
        timer = setTimeout(() => fetchSuggestions(text), DEBOUNCE_MS);
      });

      input.addEventListener('keydown', (e) => {
        if (list.classList.contains('hidden')) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          active = (active + step + suggestions.length) % suggestions.length;
          showList();
        } else if (e.key === 'Enter' && active >= 0) {
          e.preventDefault(); // pick, don't submit the form
          pick(active);
        } else if (e.key === 'Escape') {
          close();
        }
      });

      // pointerdown, not click, so the box doesn't lose focus (and close the
      // list) before the pick registers.
      list.addEventListener('pointerdown', (e) => {
        const option = e.target.closest('.ac-option');
        if (!option) return;
        e.preventDefault();
        pick(Number(option.dataset.index));
      });

      input.addEventListener('blur', () => {
        close();
        state.render();
      });
      input.addEventListener('focus', state.render);

      state.render();
    });
  }

  // Before saving: if any of `inputs` holds an address that wasn't picked
  // from the suggestions, asks (in the app's own pop-up) whether to use it
  // anyway. Resolves to true to go ahead (also when suggestions aren't set
  // up, so there was nothing to pick).
  async function confirmUnverified(inputs) {
    const unverified = inputs
      .filter((input) => {
        const state = states.get(input);
        return state && state.enabled && input.value.trim() && !isVerified(input);
      })
      .map((input) => input.value.trim());
    if (!unverified.length) return true;
    const one = unverified.length === 1;
    return Dialog.confirm({
      title: one ? 'Address not found on the map' : 'Addresses not found on the map',
      message: `${one ? "This address isn't" : "These addresses aren't"} on the map, so drivers' map links might not go to the right place.`,
      items: unverified,
      confirmText: one ? 'Use it anyway' : 'Use them anyway',
      cancelText: 'Pick from the list',
    });
  }

  return { attach, isVerified, setVerified, confirmUnverified };
})();
