// Reads live / 24h / 7d / all-time visitor counts from the "visits"
// sorted set that ping.js writes to: ZCOUNT for the three windowed
// figures, ZCARD for all-time (every unique visitor ever seen).

const { getClient } = require('../lib/redis');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const clientPromise = getClient();
  if (!clientPromise) {
    res.status(200).json({ configured: false, live: null, last24h: null, last7d: null, allTime: null });
    return;
  }

  try {
    const client = await clientPromise;
    const now = Math.floor(Date.now() / 1000);
    const [live, last24h, last7d, allTime] = await Promise.all([
      client.zCount('visits', now - 60, '+inf'),
      client.zCount('visits', now - 86400, '+inf'),
      client.zCount('visits', now - 604800, '+inf'),
      client.zCard('visits'),
    ]);
    res.status(200).json({ configured: true, live, last24h, last7d, allTime });
  } catch {
    res.status(200).json({ configured: false, live: null, last24h: null, last7d: null, allTime: null });
  }
};
