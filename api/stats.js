// Reads live / 24h / 7d / all-time visitor counts from the "visits"
// sorted set that ping.js writes to. All four are derived from the same
// set (ZCOUNT for the windowed ones, ZCARD for all-time), so a single
// Redis pipeline call answers all of them.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.KV_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!REST_URL || !REST_TOKEN) {
    res.status(200).json({ configured: false, live: null, last24h: null, last7d: null, allTime: null });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const commands = [
    ['ZCOUNT', 'visits', now - 60, '+inf'],
    ['ZCOUNT', 'visits', now - 86400, '+inf'],
    ['ZCOUNT', 'visits', now - 604800, '+inf'],
    ['ZCARD', 'visits'],
  ];

  try {
    const r = await fetch(`${REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    const data = await r.json();
    const nums = data.map((d) => Number(d?.result) || 0);
    res.status(200).json({
      configured: true,
      live: nums[0],
      last24h: nums[1],
      last7d: nums[2],
      allTime: nums[3],
    });
  } catch {
    res.status(200).json({ configured: false, live: null, last24h: null, last7d: null, allTime: null });
  }
};
