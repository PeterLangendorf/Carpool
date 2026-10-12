// `npm run lint`. ESLint's recommended rules, with the right globals for each
// part of the app: Node (CommonJS) for the server, functions, tests and
// scripts; plain browser scripts (no modules) for public/.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', '.netlify/', 'graphify-out/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
  },
  {
    // The pages load these as plain <script>s, sharing globals.
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    // Each page's own script uses what the shared ones define: auth.js
    // `auth`, activity-times.js `ActivityTimes`, loader.js `CAR_SVG`,
    // address-autocomplete.js `AddressAutocomplete` and dialog.js `Dialog`.
    files: ['public/app.js', 'public/dashboard.js', 'public/sign-in.js', 'public/notifications.js'],
    languageOptions: {
      globals: { auth: 'readonly', ActivityTimes: 'readonly', CAR_SVG: 'readonly', AddressAutocomplete: 'readonly', Dialog: 'readonly' },
    },
  },
  {
    files: ['public/address-autocomplete.js'],
    languageOptions: { globals: { Dialog: 'readonly' } },
  },
  {
    // Also require()d by the server.
    files: ['public/activity-times.js'],
    languageOptions: { globals: { module: 'readonly' } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
