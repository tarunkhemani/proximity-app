import express from 'express';
import mongoose from 'mongoose';

import Message, { MESSAGE_TYPES } from '../models/Message.js';
import User from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All message routes require authentication
router.use(authenticateToken);

// ── GET /api/messages/inbox ────────────────────────────────────────────────────
// Returns the authenticated user's conversation list — one entry per unique
// room, showing the latest message and unread count.
// Used by the radar page sidebar / conversation list.
router.get('/inbox', async (req, res) => {
  try {
    const userId = req.user._id;

    const conversations = await Message.aggregate([
      // Find all messages where this user is a participant
      {
        $match: {
          $or: [
            { senderId:    userId },
            { recipientId: userId },
          ],
          // Exclude system noise from the preview
          type: { $nin: [MESSAGE_TYPES.CONNECT_DECLINE] },
          // Exclude soft-deleted messages
          $nor: [
            { senderId:    userId, deletedBySender:    true },
            { recipientId: userId, deletedByRecipient: true },
          ],
        },
      },

      // Sort newest first so $last in the group gives us the most recent message
      { $sort: { createdAt: -1 } },

      // Group by room — one document per conversation
      {
        $group: {
          _id:          '$roomId',
          lastMessage:  { $first: '$$ROOT' },       // most recent message
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq:  ['$recipientId', userId] },
                    { $eq:  ['$readAt', null] },
                    { $eq:  ['$delivered', true] },
                    { $ne:  ['$deletedByRecipient', true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          totalMessages: { $sum: 1 },
        },
      },

      // Sort conversations by most recent message
      { $sort: { 'lastMessage.createdAt': -1 } },

      // Join the other participant's profile
      {
        $lookup: {
          from: 'users',
          let: {
            roomId: '$_id',
            myId:   userId,
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  // The other participant's ID is embedded in the roomId string.
                  // We fetch both participants and filter out self in application code
                  // because MongoDB can't do string splitting in $expr cleanly.
                  $and: [
                    { $ne: ['$_id', '$$myId'] },
                  ],
                },
              },
            },
            {
              $project: {
                _id:    1,
                name:   1,
                avatar: 1,
                bio:    1,
                tags:   1,
              },
            },
          ],
          as: 'allUsers',
        },
      },
    ]);

    // Resolve the other participant per conversation in application code.
    // (The $lookup above fetches all users — we pick the right one by checking
    // whose ObjectId string appears in the roomId.)
    const result = await Promise.all(
      conversations.map(async (conv) => {
        const roomId = conv._id;
        const participantIds = roomId.split('_');
        const otherUserId = participantIds.find((id) => id !== userId.toString());

        let otherUser = null;
        if (otherUserId && mongoose.Types.ObjectId.isValid(otherUserId)) {
          otherUser = await User.findById(otherUserId)
            .select('name avatar bio tags isVisible beaconExpiresAt')
            .lean();
        }

        return {
          roomId,
          otherUser,
          lastMessage:   conv.lastMessage,
          unreadCount:   conv.unreadCount,
          totalMessages: conv.totalMessages,
        };
      })
    );

    // Filter out any conversations where the other user could not be resolved
    const clean = result.filter((c) => c.otherUser !== null);

    res.status(200).json({ conversations: clean });
  } catch (err) {
    console.error('[messages/inbox]', err.message);
    res.status(500).json({ error: 'Failed to load inbox.' });
  }
});

// ── GET /api/messages/:roomId ─────────────────────────────────────────────────
// Returns paginated message history for a specific room.
// Uses cursor-based pagination — pass ?before=<messageId> to load older messages.
router.get('/:roomId', async (req, res) => {
  try {
    const { roomId }    = req.params;
    const { before, limit = 30 } = req.query;
    const userId        = req.user._id;

    // ── Validate roomId format ──────────────────────────────────────────────
    if (!/^[a-f0-9]{24}_[a-f0-9]{24}$/.test(roomId)) {
      return res.status(400).json({ error: 'Invalid roomId format.' });
    }

    // ── Authorisation: requester must be a participant ──────────────────────
    const participantIds = roomId.split('_');
    if (!participantIds.includes(userId.toString())) {
      return res.status(403).json({ error: 'You are not a participant of this conversation.' });
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

    const messages = await Message.getConversationHistory({
      roomId,
      limit: parsedLimit,
      beforeId: before || null,
    });

    // Messages come back newest-first from the DB query — reverse for display
    const ordered = [...messages].reverse();

    // Mark messages as delivered for the recipient
    await Message.updateMany(
      {
        roomId,
        recipientId: userId,
        delivered:   false,
      },
      { $set: { delivered: true } }
    );

    // Resolve the other participant's public profile to attach to the response
    const otherUserId = participantIds.find((id) => id !== userId.toString());
    const otherUser   = otherUserId
      ? await User.findById(otherUserId)
          .select('name avatar bio tags isVisible beaconExpiresAt')
          .lean()
      : null;

    res.status(200).json({
      messages:   ordered,
      otherUser,
      hasMore:    messages.length === parsedLimit, // true → more pages exist
      oldestId:   ordered[0]?._id ?? null,         // use as `before` on next page load
    });
  } catch (err) {
    console.error('[messages/:roomId]', err.message);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// ── DELETE /api/messages/:roomId ──────────────────────────────────────────────
// Soft-delete all messages from this user's perspective.
// The conversation remains visible to the other participant.
router.delete('/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId     = req.user._id;

    const participantIds = roomId.split('_');
    if (!participantIds.includes(userId.toString())) {
      return res.status(403).json({ error: 'Not a participant of this conversation.' });
    }

    // Determine which soft-delete flag to set based on whether this user is
    // the sender or recipient of each message
    await Promise.all([
      Message.updateMany(
        { roomId, senderId: userId },
        { $set: { deletedBySender: true } }
      ),
      Message.updateMany(
        { roomId, recipientId: userId },
        { $set: { deletedByRecipient: true } }
      ),
    ]);

    res.status(200).json({ message: 'Conversation deleted.' });
  } catch (err) {
    console.error('[messages/delete]', err.message);
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

export default router;