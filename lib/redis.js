// Shared Redis connection for the serverless functions in /api.
// Cached at module scope so a warm Vercel function instance reuses one
// connection across invocations instead of reconnecting every request.

const { createClient } = require('redis');

let clientPromise = null;

function getClient() {
  const url =
    process.env.REDIS_URL ||
    process.env.REDIS_CONNECTION_STRING ||
    process.env.KV_URL;
  if (!url) return null;

  if (!clientPromise) {
    const client = createClient({ url });
    client.on('error', (err) => console.error('redis client error', err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

module.exports = { getClient };
