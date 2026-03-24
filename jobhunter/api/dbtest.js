const mongoose = require('mongoose');

module.exports = async (req, res) => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) return res.json({ error: 'MONGODB_URI not set' });

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, tls: true, tlsAllowInvalidCertificates: true });
    }
    const collections = await mongoose.connection.db.listCollections().toArray();
    res.json({ ok: true, collections: collections.map(c => c.name) });
  } catch (err) {
    res.json({ ok: false, error: err.message, code: err.code });
  }
};
