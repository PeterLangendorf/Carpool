// Runs the whole app on this machine with no Netlify involvement: serves
// public/ and the /api routes from one Express server, storing data in
// local-db.json instead of Netlify Blobs. Listens on all network interfaces
// so phones on the same Wi-Fi can connect.
const path = require('path');
const os = require('os');

process.env.LOCAL_DB_FILE = process.env.LOCAL_DB_FILE || path.join(__dirname, 'local-db.json');

const express = require('express');
const api = require('./src/app');

const PORT = Number(process.env.PORT) || 8888;
const site = express();
site.use(api);
site.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

site.listen(PORT, '0.0.0.0', () => {
  console.log(`Carpool running locally (data in ${process.env.LOCAL_DB_FILE})`);
  console.log(`  This computer: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .forEach((i) => console.log(`  On your Wi-Fi: http://${i.address}:${PORT}`));
});
