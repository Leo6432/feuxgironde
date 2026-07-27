// Records a visitor "last seen" timestamp in a single Redis sorted set
// (member = anonymous client-generated id, score = unix seconds).
// stats.js derives live/24h/7d/all-time counts from ZCOUNT/ZCARD on that
// same set, so a visitor only ever occupies one entry no matter how many
// times they ping.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.KV_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!REST_URL || !REST_TOKEN) {
    res.status(200).json({ ok: false, reason: 'not configured' });
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

  const now = Math.floor(Date.now() / 1000);
  try {
    await fetch(`${REST_URL}/zadd/visits/${now}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${REST_TOKEN}` },
    });
    res.status(204).end();
  } catch {
    res.status(200).json({ ok: false });
  }
};
