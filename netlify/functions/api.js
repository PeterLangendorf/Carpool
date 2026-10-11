const serverless = require('serverless-http');
const { connectLambda } = require('@netlify/blobs');
const app = require('../../src/app');
const store = require('../../src/store');

const serverlessHandler = serverless(app);

// serverless-http exposes this function as a classic AWS Lambda handler
// (event, context) rather than Netlify's native (Request, Context) shape, so
// Netlify doesn't auto-inject Blobs' site/token context for it — connectLambda
// wires that up manually from the raw event before each invocation. The store
// also needs the event for strongly consistent reads (see src/store.js).
module.exports.handler = (event, context) => {
  connectLambda(event);
  store.useLambdaBlobsContext(event);
  return serverlessHandler(event, context);
};
