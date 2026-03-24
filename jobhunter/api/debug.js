module.exports = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const uri = process.env.MONGODB_URI || 'not set';
    res.json({
      uri_set: !!process.env.MONGODB_URI,
      uri_start: uri.substring(0, 30) + '...',
      readyState: mongoose.connection.readyState
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
};
