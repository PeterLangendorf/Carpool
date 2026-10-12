// An in-memory stand-in for Netlify Blobs with real ETag/conditional-write
// behaviour and small random delays, so simultaneous requests interleave the
// way they can in production. Call install() before requiring src/store.js.
const path = require('path');

function createFakeBlobs() {
  const data = new Map(); // key -> { json, etag }
  let etagCounter = 0;
  const delay = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
  const write = (key, value) => {
    const etag = String(++etagCounter);
    data.set(key, { json: JSON.stringify(value), etag });
    return etag;
  };
  const store = {
    async get(key) {
      await delay();
      const entry = data.get(key);
      return entry ? JSON.parse(entry.json) : null;
    },
    async getWithMetadata(key) {
      await delay();
      const entry = data.get(key);
      return entry ? { data: JSON.parse(entry.json), etag: entry.etag, metadata: {} } : null;
    },
    async set(key, value) {
      await delay();
      write(key, value);
      return { modified: true };
    },
    async setJSON(key, value, { onlyIfMatch, onlyIfNew } = {}) {
      await delay();
      const entry = data.get(key);
      if (onlyIfNew && entry) return { modified: false };
      if (onlyIfMatch && (!entry || entry.etag !== onlyIfMatch)) return { modified: false };
      return { modified: true, etag: write(key, value) };
    },
    async list({ prefix }) {
      await delay();
      return { blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
  return { store, data, write };
}

function install() {
  const fake = createFakeBlobs();
  const blobsPath = require.resolve('@netlify/blobs', { paths: [path.join(__dirname, '..')] });
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => fake.store } };
  return fake;
}

module.exports = { install };
