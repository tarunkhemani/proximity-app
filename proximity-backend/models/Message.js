import mongoose from 'mongoose';

// Discriminated via the `type` field so the frontend can render each variant
// with a different UI component without parsing content strings.
export const MESSAGE_TYPES = {
  TEXT: 'text',                       // regular chat message
  CONNECT_REQUEST: 'connect_request', // "Hey, want to connect?" card
  CONNECT_ACCEPT: 'connect_accept',   // "X accepted your request" notification
  CONNECT_DECLINE: 'connect_decline', // "X declined your request" notification
  SYSTEM: 'system',                   // e.g. "You are now connected" banner
};

const MessageSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: [true, 'roomId is required'],
      index: true,
      validate: {
        // Basic format guard — two 24-char ObjectId hex strings joined by '_'
        validator: (v) => /^[a-f0-9]{24}_[a-f0-9]{24}$/.test(v),
        message: 'roomId must be two ObjectId strings joined by "_" (sorted)',
      },
    },

    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'senderId is required'],
    },

    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'recipientId is required'],
    },

    content: {
      type: String,
      trim: true,
      maxlength: [1000, 'Message content cannot exceed 1000 characters'],
      // content is optional for non-text types (e.g. connect_accept has no body)
      default: '',
    },

    type: {
      type: String,
      enum: {
        values: Object.values(MESSAGE_TYPES),
        message: `Message type must be one of: ${Object.values(MESSAGE_TYPES).join(', ')}`,
      },
      default: MESSAGE_TYPES.TEXT,
    },

    delivered: {
      type: Boolean,
      default: false,
    },

    // readAt: null until the recipient opens the conversation. Used to render
    // read receipts (single grey tick → double blue tick pattern).
    readAt: {
      type: Date,
      default: null,
    },

    deletedBySender: {
      type: Boolean,
      default: false,
    },
    deletedByRecipient: {
      type: Boolean,
      default: false,
    },

    meetZone: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt = message send time, updatedAt = last edit/read
    versionKey: false,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Primary query pattern: "give me the last N messages in room X, newest first"
// This is hit on every chat open and on pagination scroll — must be fast.
MessageSchema.index({ roomId: 1, createdAt: -1 });

// Inbox query: "give me all rooms where this user has unread messages"
// Used to render notification badges on the conversations list screen.
MessageSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

// Sender history: "give me all conversations this user initiated"
MessageSchema.index({ senderId: 1, createdAt: -1 });

// buildRoomId: the canonical way to construct a roomId anywhere in the codebase.
// Import this function instead of recreating the sort logic inline.
MessageSchema.statics.buildRoomId = function (userIdA, userIdB) {
  return [userIdA.toString(), userIdB.toString()].sort().join('_');
};

MessageSchema.statics.getConversationHistory = async function ({
  roomId,
  limit = 30,
  beforeId = null, // fetch messages older than this message ID (for "load more")
}) {
  const query = {
    roomId,
    deletedBySender: false,
    deletedByRecipient: false,
  };

  // If beforeId is provided, only fetch messages older than it
  if (beforeId) {
    query._id = { $lt: new mongoose.Types.ObjectId(beforeId) };
  }

  return this.find(query)
    .sort({ createdAt: -1 }) // newest first — the client reverses for display
    .limit(limit)
    .populate('senderId', 'name avatar') // attach basic sender profile
    .lean(); // return plain objects — faster than full Mongoose documents for reads
};

// getUnreadCount: returns the number of unread messages for a user across all rooms.
// Called on socket connection to populate the badge count in the nav bar.
MessageSchema.statics.getUnreadCount = async function (userId) {
  return this.countDocuments({
    recipientId: userId,
    readAt: null,
    delivered: true,
    deletedByRecipient: false,
  });
};

// markRoomAsRead: stamps all unread messages in a room with the current timestamp.
// Called when the recipient opens the chat window.
MessageSchema.statics.markRoomAsRead = async function (roomId, recipientId) {
  return this.updateMany(
    {
      roomId,
      recipientId,
      readAt: null,
    },
    {
      $set: { readAt: new Date() },
    }
  );
};

const Message = mongoose.model('Message', MessageSchema);

export default Message;
