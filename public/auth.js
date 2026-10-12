// Clerk sign-in, shared by every page (load before the page's own script).
// Fetches the publishable key from /api/config and loads Clerk's browser
// scripts from the instance's Frontend API. Pages don't sign people in
// themselves: they send them to /sign-in (sign-in.html) with a redirect_url to
// come back to, only at the point an account is actually needed.
/* exported auth */
const auth = (() => {
  function loadScript(src, attrs = {}) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      Object.entries(attrs).forEach(([k, v]) => script.setAttribute(k, v));
      script.onload = resolve;
      script.onerror = () => reject(new Error("Couldn't load sign-in. Check your connection and reload."));
      document.head.appendChild(script);
    });
  }

  // A publishable key is "pk_test_" or "pk_live_" plus the base64 of
  // "<frontend api host>$".
  function frontendApiFromKey(key) {
    const encoded = key.replace(/^pk_(test|live)_/, '');
    return atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')).replace(/\$$/, '');
  }

  const ready = (async () => {
    const res = await fetch('/api/config');
    const { clerkPublishableKey } = await res.json();
    if (!clerkPublishableKey) throw new Error("Sign-in isn't set up yet.");
    const fapi = frontendApiFromKey(clerkPublishableKey);
    await loadScript(`https://${fapi}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${fapi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      'data-clerk-publishable-key': clerkPublishableKey,
    });
    // Clerk navigates once signing in/out has finished (to the sign-in page's
    // redirect_url, or home after signing out). Reloading from an auth
    // listener instead can cut a sign-out short and leave the session in place.
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      signInUrl: '/sign-in',
      signUpUrl: '/sign-in',
      afterSignOutUrl: '/',
      // Opt out of Clerk's usage telemetry (it only runs for development instances).
      telemetry: false,
      // Match the site's look (navy, system font) instead of Clerk's defaults.
      appearance: {
        variables: {
          colorPrimary: '#174597',
          borderRadius: '10px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
        },
      },
    });
    return window.Clerk;
  })();
  ready.catch(() => {}); // callers that care handle it; the rest just see no user

  // The signed-in Clerk user, or null (signed out, or sign-in not set up).
  async function currentUser() {
    try {
      return (await ready).user || null;
    } catch {
      return null;
    }
  }

  // `reason` picks the sign-in page's wording: 'create', 'join' or none.
  function signInUrl(returnTo, reason) {
    const params = new URLSearchParams({ redirect_url: returnTo });
    if (reason) params.set('reason', reason);
    return `/sign-in?${params}`;
  }

  // Goes to the sign-in page, which comes back to `returnTo` afterwards.
  // Never resolves, so callers can `return auth.redirectToSignIn(...)`.
  function redirectToSignIn(returnTo, reason) {
    window.location.href = signInUrl(returnTo, reason);
    return new Promise(() => {});
  }

  // Resolves with the signed-in user, or sends them to sign in first.
  async function requireSignIn(returnTo = window.location.pathname + window.location.search, reason) {
    return (await currentUser()) || redirectToSignIn(returnTo, reason);
  }

  // fetch() with the signed-in user's session token attached, plus their time
  // zone, which a carpool adopts if it doesn't have one yet (see src/dates.js).
  async function authFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    try {
      headers['X-Time-Zone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // No time zone available: the server falls back to UTC.
    }
    try {
      const clerk = await ready;
      const token = clerk.session ? await clerk.session.getToken() : null;
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
      // Sign-in not set up: send the request without a token.
    }
    return fetch(path, { ...options, headers });
  }

  async function mountUserButton(el) {
    const clerk = await ready;
    clerk.mountUserButton(el);
  }

  return { ready, currentUser, signInUrl, redirectToSignIn, requireSignIn, fetch: authFetch, mountUserButton };
})();
