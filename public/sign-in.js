// The sign-in page (/sign-in). Other pages send people here with
// ?redirect_url=<where to come back to>&reason=create|join, and Clerk's sign-in
// (or sign-up) sends them back there once they're in.

// Only same-site paths, so a crafted link can't bounce people to another site
// after they sign in ("//evil.example" and "/\evil.example" are other sites).
function safeRedirectUrl(raw) {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}

const params = new URLSearchParams(window.location.search);
const redirectUrl = safeRedirectUrl(params.get('redirect_url'));

const WORDING = {
  create: {
    title: 'Sign in to finish your carpool',
    subtitle: "Your carpool details are saved. Sign in or create an account, then add yourself and your rides.",
  },
  join: {
    title: 'Sign in to join',
    subtitle: "Carpools include addresses and riders' names, so only signed-in members can see them.",
  },
};
const wording = WORDING[params.get('reason')];
if (wording) {
  document.getElementById('signInTitle').textContent = wording.title;
  document.getElementById('signInSubtitle').textContent = wording.subtitle;
}

auth.ready.then(
  (clerk) => {
    if (clerk.user) {
      window.location.replace(redirectUrl);
      return;
    }
    clerk.mountSignIn(document.getElementById('signInMount'), {
      withSignUp: true,
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    });
  },
  (err) => {
    document.getElementById('signInErrorText').textContent = err.message;
    document.getElementById('signInError').classList.remove('hidden');
  }
);
