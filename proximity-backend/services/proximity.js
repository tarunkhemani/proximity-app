import mongoose from 'mongoose';
import Location from '../models/Location.js';
import { pubClient, RedisKeys } from '../config/redis.js';

export async function getNearbyUsers({
  coords,
  excludeUserId,
  radiusMeters = 200,
  limit = 50,
}) {
  const stalenessThreshold = new Date(Date.now() - 90 * 1000);

  const pipeline = [
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: coords,
        },
        distanceField: 'distanceMeters',
        maxDistance: radiusMeters,
        spherical: true,
        query: {
          updatedAt: { $gte: stalenessThreshold },
          userId: { $ne: new mongoose.Types.ObjectId(excludeUserId) },
        },
        distanceMultiplier: 1,
      },
    },

    {
      $lookup: {
        from: 'users',
        let: { uid: '$userId' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$_id', '$$uid'] },
            },
          },
          {
            $project: {
              _id:             1,
              name:            1,
              avatar:          1,
              bio:             1,
              tags:            1,
              isVisible:       1,
              beaconExpiresAt: 1,
              isActive:        1,
            },
          },
        ],
        as: 'user',
      },
    },

    {
      $unwind: {
        path: '$user',
        preserveNullAndEmptyArrays: false,
      },
    },

    {
      $match: {
        'user.isVisible':       true,
        'user.isActive':        true,
        'user.beaconExpiresAt': { $gt: new Date() },
      },
    },

    {
      $project: {
        _id: 0,
        userId:          '$user._id',
        name:            '$user.name',
        avatar:          '$user.avatar',
        bio:             '$user.bio',
        tags:            '$user.tags',
        zone:            1,
        distanceMeters:  { $round: ['$distanceMeters', 0] },
        beaconExpiresAt: '$user.beaconExpiresAt',
      },
    },

    {
      $sort: {
        distanceMeters: 1,
        name:           1,
      },
    },

    {
      $limit: limit,
    },
  ];

  const results = await Location.aggregate(pipeline).exec();

  return results;
}

export async function filterOnlineUsers(nearbyUsers) {
  if (nearbyUsers.length === 0) return [];

  const presenceKeys   = nearbyUsers.map((u) => RedisKeys.presence(u.userId.toString()));
  const presenceValues = await pubClient.mget(...presenceKeys);

  return nearbyUsers.map((user, index) => ({
    ...user,
    isOnline: presenceValues[index] === '1',
  }));
}

export async function getNearbyAndOnlineUsers(options) {
  const nearby = await getNearbyUsers(options);
  return filterOnlineUsers(nearby);
}

export async function getZoneSummary(stalenessSeconds = 90) {
  const cutoff = new Date(Date.now() - stalenessSeconds * 1000);

  return Location.aggregate([
    {
      $match: {
        updatedAt: { $gte: cutoff },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },
    {
      $match: {
        'user.isVisible':       true,
        'user.isActive':        true,
        'user.beaconExpiresAt': { $gt: new Date() },
      },
    },
    {
      $group: {
        _id:   '$zone',
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id:   0,
        zone:  '$_id',
        count: 1,
      },
    },
    {
      $sort: { count: -1 },
    },
  ]).exec();
}

