module.exports = (req, res) => {
  res.json({ ok: true, env: !!process.env.MONGODB_URI, vercel: !!process.env.VERCEL });
};
