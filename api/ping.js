// Records a visitor "last seen" timestamp in a single Redis sorted set
// (member = anonymous client-generated id, score = unix seconds).
// stats.js derives live/24h/7d/all-time counts from ZCOUNT/ZCARD on that
// same set, so a visitor only ever occupies one entry no matter how many
// times they ping.

const { getClient } = require('../lib/redis');

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!ID_RE.test(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }

  const clientPromise = getClient();
  if (!clientPromise) {
    res.status(200).json({ ok: false, reason: 'not configured' });
    return;
  }

  try {
    const client = await clientPromise;
    await client.zAdd('visits', { score: Math.floor(Date.now() / 1000), value: id });
    res.status(204).end();
  } catch {
    res.status(200).json({ ok: false });
  }
};
