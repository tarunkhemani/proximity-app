import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export async function authenticateToken(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const token = header.slice(7);

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'proximity-api',
        audience: 'proximity-client',
      });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired.' });
      }
      return res.status(401).json({ error: 'Invalid token.' });
    }

    const user = await User.findById(payload.userId).lean();

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or deactivated.' });
    }

    // Attach to request — available as req.user in all downstream handlers
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth middleware]', err.message);
    res.status(500).json({ error: 'Authentication error.' });
  }
}
