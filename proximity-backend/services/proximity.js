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

  console.log('[proximity] getNearbyUsers called with:', {
    coords,
    excludeUserId,
    radiusMeters,
    stalenessThreshold,
  });

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

  // ── FIX: await was missing — without it `results` is a pending Promise,
  // the log prints garbage, and filterOnlineUsers receives nothing useful.
  // The caller still got the right answer because it awaited the returned
  // Promise, but this function's own log was always wrong.
  const results = await Location.aggregate(pipeline).exec();

  console.log(`[proximity] Aggregation returned ${results.length} result(s):`, results);

  return results;
}

export async function filterOnlineUsers(nearbyUsers) {
  if (nearbyUsers.length === 0) return [];

  const presenceKeys   = nearbyUsers.map((u) => RedisKeys.presence(u.userId.toString()));
  const presenceValues = await pubClient.mget(...presenceKeys);

  console.log('[proximity] Redis presence check:',
    presenceKeys.map((key, i) => ({ key, value: presenceValues[i] }))
  );

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
// import mongoose from 'mongoose';
// import Location from '../models/Location.js';
// import { pubClient, RedisKeys } from '../config/redis.js';

// // ── getNearbyUsers ─────────────────────────────────────────────────────────────
// // The core geospatial query. Finds all users with an active beacon within
// // `radiusMeters` of the supplied coordinate, then cross-checks against Redis
// // to confirm they are currently connected via a socket.
// //
// // @param {object}   options
// // @param {number[]} options.coords          - [longitude, latitude] of the requester
// // @param {string}   options.excludeUserId   - the requesting user's own _id (string)
// // @param {number}   [options.radiusMeters]  - search radius, default 200
// // @param {number}   [options.limit]         - max results, default 50
// //
// // @returns {Promise<Array>} Array of nearby user objects (no raw GPS coordinates)
// export async function getNearbyUsers({
//   coords,
//   excludeUserId,
//   radiusMeters = 200,
//   limit = 50,
// }) {
//   const stalenessThreshold = new Date(Date.now() - 90 * 1000);
//   console.log('[proximity] getNearbyUsers called with:', {
//     coords,
//     excludeUserId,
//     radiusMeters,
//     stalenessThreshold,
//   });

//   const pipeline = [
//     // ── Stage 1: $geoNear ──────────────────────────────────────────────────
//     // MUST be the first stage — MongoDB enforces this.
//     // Filters documents by distance AND adds `distanceMeters` to each result.
//     // The `query` block runs as a pre-filter on the 2dsphere index, so only
//     // documents matching it are even considered for distance math.
//     {
//       $geoNear: {
//         near: {
//           type: 'Point',
//           coordinates: coords, // [longitude, latitude]
//         },
//         distanceField: 'distanceMeters',
//         maxDistance: radiusMeters,   // metres — mandatory for 2dsphere
//         spherical: true,             // great-circle distance
//         query: {
//           updatedAt: { $gte: stalenessThreshold },
//           // Convert string to ObjectId — the field is stored as ObjectId in Location
//           userId: { $ne: new mongoose.Types.ObjectId(excludeUserId) },
//         },
//         distanceMultiplier: 1,
//       },
//     },

//     // ── Stage 2: $lookup — join user profile ───────────────────────────────
//     // Pipeline-style $lookup lets us project inside the join so we never pull
//     // the full User document (with password hash etc.) across the boundary.
//     //
//     // ⚠️  INCLUSION-ONLY projection.
//     // MongoDB forbids mixing field: 1 and field: 0 in the same $project
//     // (the only exception is _id). Any field not listed here simply does not
//     // appear in the output — there is no need to explicitly exclude anything.
//     {
//       $lookup: {
//         from: 'users',
//         let: { uid: '$userId' },
//         pipeline: [
//           {
//             $match: {
//               $expr: { $eq: ['$_id', '$$uid'] },
//             },
//           },
//           {
//             $project: {
//               _id:             1,
//               name:            1,
//               avatar:          1,
//               bio:             1,
//               tags:            1,
//               isVisible:       1,
//               beaconExpiresAt: 1,
//               isActive:        1,
//               // password, refreshToken, email are NOT listed — they will not
//               // appear in the output. No exclusion lines needed or allowed here.
//             },
//           },
//         ],
//         as: 'user',
//       },
//     },

//     // ── Stage 3: $unwind — flatten the joined array ────────────────────────
//     // $lookup always returns an array. $unwind flattens it to a single object.
//     // preserveNullAndEmptyArrays: false silently drops orphaned location docs
//     // (locations whose user account was deleted).
//     {
//       $unwind: {
//         path: '$user',
//         preserveNullAndEmptyArrays: false,
//       },
//     },

//     // ── Stage 4: $match — enforce beacon visibility ────────────────────────
//     // Checked after the join because isVisible and beaconExpiresAt live on the
//     // User document, not on Location. Both fields are checked intentionally:
//     //   - isVisible may still be true after beaconExpiresAt passed (server restart)
//     //   - beaconExpiresAt may be set but isVisible toggled off manually
//     {
//       $match: {
//         'user.isVisible':       true,
//         'user.isActive':        true,
//         'user.beaconExpiresAt': { $gt: new Date() },
//       },
//     },

//     // ── Stage 5: $project — shape the response, redact raw GPS ────────────
//     // Privacy-critical: coordinates are projected OUT at the DB layer so they
//     // can never leak via a logging statement or future code change.
//     // Nearby users see: distance, zone label, and safe public profile fields.
//     {
//       $project: {
//         _id: 0,

//         // Public user identity
//         userId:          '$user._id',
//         name:            '$user.name',
//         avatar:          '$user.avatar',
//         bio:             '$user.bio',
//         tags:            '$user.tags',

//         // Fuzzy zone label — shown instead of raw coordinates
//         zone:            1,

//         // Distance rounded to nearest metre
//         distanceMeters:  { $round: ['$distanceMeters', 0] },

//         // Lets the UI show "Visible for X more minutes"
//         beaconExpiresAt: '$user.beaconExpiresAt',

//         // coordinates, accuracy, user.email are absent — never include them
//       },
//     },

//     // ── Stage 6: $sort — closest first ────────────────────────────────────
//     // Secondary sort on name gives stable ordering when multiple users share
//     // the same distance (e.g. everyone snapped to the same zone centroid).
//     {
//       $sort: {
//         distanceMeters: 1,
//         name:           1,
//       },
//     },

//     // ── Stage 7: $limit — cap result set ──────────────────────────────────
//     // Prevents the socket payload from growing unbounded in a dense venue.
//     {
//       $limit: limit,
//     },
//   ];
//   const results=Location.aggregate(pipeline).exec();
//   console.log(`[proximity] Aggregation returned ${results.length} result(s):`, results);

//   return results;
// }

// // ── filterOnlineUsers ──────────────────────────────────────────────────────────
// // Cross-references each nearby user against Redis presence keys to determine
// // who is currently connected via a socket.
// //
// // Kept separate from the aggregation because MongoDB cannot query Redis.
// // The aggregation finds users who WANT to be visible; this narrows to those
// // who ARE online right now.
// //
// // Uses a single Redis MGET for all keys — O(1) round-trips regardless of N.
// //
// // @param {Array}  nearbyUsers  - result array from getNearbyUsers
// // @returns {Promise<Array>}    - same array annotated with `isOnline: boolean`
// export async function filterOnlineUsers(nearbyUsers) {
//   if (nearbyUsers.length === 0) return [];

//   const presenceKeys   = nearbyUsers.map((u) => RedisKeys.presence(u.userId.toString()));
//   const presenceValues = await pubClient.mget(...presenceKeys);

//    console.log('[proximity] Redis presence check:',
//     presenceKeys.map((key, i) => ({ key, value: presenceValues[i] }))
//   );

//   return nearbyUsers.map((user, index) => ({
//     ...user,
//     isOnline: presenceValues[index] === '1',
//   }));
// }

// // ── getNearbyAndOnlineUsers ────────────────────────────────────────────────────
// // Convenience wrapper — runs the aggregation then the Redis presence check.
// // This is what the socket handler calls on every location:update event.
// //
// // @param {object} options  - same options as getNearbyUsers
// // @returns {Promise<Array>}
// export async function getNearbyAndOnlineUsers(options) {
//   const nearby = await getNearbyUsers(options);
//   return filterOnlineUsers(nearby);
// }

// // ── getZoneSummary ─────────────────────────────────────────────────────────────
// // Returns an aggregated count of visible users per zone — used to render a
// // heatmap or hotspot view without exposing individual user identities.
// //
// // @param {number} [stalenessSeconds]  - max age of a location document, default 90s
// // @returns {Promise<Array>}           - [{ zone: string, count: number }]
// export async function getZoneSummary(stalenessSeconds = 90) {
//   const cutoff = new Date(Date.now() - stalenessSeconds * 1000);

//   return Location.aggregate([
//     // Only consider fresh location documents
//     {
//       $match: {
//         updatedAt: { $gte: cutoff },
//       },
//     },

//     // Join user to check beacon status
//     {
//       $lookup: {
//         from: 'users',
//         localField: 'userId',
//         foreignField: '_id',
//         as: 'user',
//       },
//     },
//     {
//       $unwind: '$user',
//     },

//     // Only count users who are actively beaconing
//     {
//       $match: {
//         'user.isVisible':       true,
//         'user.isActive':        true,
//         'user.beaconExpiresAt': { $gt: new Date() },
//       },
//     },

//     // Group by zone label and count occupants
//     {
//       $group: {
//         _id:   '$zone',
//         count: { $sum: 1 },
//       },
//     },

//     // ── Bug fix: this $project previously had the wrong fields ────────────
//     // It was copied from getNearbyUsers's Stage 5 and referenced fields that
//     // don't exist after a $group stage (distanceMeters, user.name, etc.).
//     // After $group the only available fields are _id (the group key) and any
//     // accumulators — in this case just `count`.
//     {
//       $project: {
//         _id:   0,
//         zone:  '$_id',
//         count: 1,
//       },
//     },

//     // Most populated zones first
//     {
//       $sort: { count: -1 },
//     },
//   ]).exec();
// }
// import mongoose from 'mongoose';
// import Location from '../models/Location.js';
// import { pubClient, RedisKeys } from '../config/redis.js';

// // ── getNearbyUsers ─────────────────────────────────────────────────────────────
// // The core geospatial query. Finds all users with an active beacon within
// // `radiusMeters` of the supplied coordinate, then cross-checks against Redis
// // to confirm they are currently connected via a socket.
// //
// // @param {object}   options
// // @param {number[]} options.coords          - [longitude, latitude] of the requester
// // @param {string}   options.excludeUserId   - the requesting user's own _id (string)
// // @param {number}   [options.radiusMeters]  - search radius, default 200
// // @param {number}   [options.limit]         - max results, default 50
// //
// // @returns {Promise<Array>} Array of nearby user objects (no raw GPS coordinates)
// export async function getNearbyUsers({
//   coords,
//   excludeUserId,
//   radiusMeters = 200,
//   limit = 50,
// }) {
//   // The staleness cutoff used inside the pipeline.
//   // 90 seconds is tighter than the 120-second TTL index — this compensates
//   // for the up-to-60s lag before MongoDB's TTL background task fires,
//   // ensuring stale documents don't appear in results even if they haven't
//   // been physically deleted yet.
//   const stalenessThreshold = new Date(Date.now() - 90 * 1000);

//   const pipeline = [
//     // ── Stage 1: $geoNear ──────────────────────────────────────────────────
//     // MUST be the first stage in any aggregation pipeline — MongoDB enforces this.
//     // Filters documents by distance AND adds `distanceMeters` to each result.
//     //
//     // `query` here runs BEFORE the geospatial filter, acting as a pre-filter
//     // on the 2dsphere index — only documents matching `query` are considered
//     // for distance calculation. This is significantly cheaper than a $match
//     // stage after $geoNear because fewer documents go through the distance math.
//     {
//       $geoNear: {
//         near: {
//           type: 'Point',
//           coordinates: coords, // [longitude, latitude]
//         },
//         distanceField: 'distanceMeters', // added to each output document
//         maxDistance: radiusMeters,        // in metres — MongoDB uses metres for 2dsphere
//         spherical: true,                  // required for 2dsphere (uses great-circle distance)
//         query: {
//           // Only consider fresh location documents
//           updatedAt: { $gte: stalenessThreshold },
//           // Exclude the requesting user's own document.
//           // We must convert the string ID to ObjectId here because the
//           // field in the Location document is stored as ObjectId, not string.
//           userId: { $ne: new mongoose.Types.ObjectId(excludeUserId) },
//         },
//         // distanceMultiplier: 1 keeps the output in metres (default for spherical)
//         distanceMultiplier: 1,
//       },
//     },

//     // ── Stage 2: $lookup — join user profile ───────────────────────────────
//     // Fetches the corresponding User document for each location result.
//     // We use a pipeline-style $lookup so we can project inside the join
//     // and avoid pulling the entire User document (especially the password hash)
//     // across the aggregation boundary.
// {
//   $lookup: {
//     from: 'users',
//     let: { uid: '$userId' },
//     pipeline: [
//       {
//         $match: {
//           $expr: { $eq: ['$_id', '$$uid'] },
//         },
//       },
//       {
//         $project: {
//           // ── INCLUSION ONLY — do not mix in any `field: 0` lines ──────────
//           // MongoDB rule: a projection is either all-inclusion or all-exclusion.
//           // The sole exception is _id, which can be suppressed in either mode.
//           // Every field not listed here is automatically absent from the output,
//           // so the password/refreshToken/email exclusions were both illegal
//           // AND unnecessary — they can never appear if we never include them.
//           _id:            1,
//           name:           1,
//           avatar:         1,
//           bio:            1,
//           tags:           1,
//           isVisible:      1,
//           beaconExpiresAt:1,
//           isActive:       1,
//           // ❌ REMOVED: password: 0,
//           // ❌ REMOVED: refreshToken: 0,
//           // ❌ REMOVED: email: 0,
//         },
//       },
//     ],
//     as: 'user',
//   },
// },

//     // ── Stage 3: $unwind — flatten the joined array ────────────────────────
//     // $lookup always returns an array. $unwind flattens it to a single object.
//     // preserveNullAndEmptyArrays: false means location documents with no
//     // matching User (orphaned locations from deleted accounts) are silently dropped.
//     {
//       $unwind: {
//         path: '$user',
//         preserveNullAndEmptyArrays: false,
//       },
//     },

//     // ── Stage 4: $match — enforce beacon visibility ────────────────────────
//     // Filter out users whose beacon has expired or who are not visible.
//     // We check this AFTER the join because these fields live on the User document,
//     // not on Location. The $geoNear pre-filter already handles staleness on the
//     // Location side; this stage handles the business logic on the User side.
//     //
//     // Checking both isVisible AND beaconExpiresAt is intentional:
//     //   - isVisible may be true but beaconExpiresAt may be in the past if
//     //     the server-side auto-shutoff timeout didn't fire (e.g. server restart)
//     //   - beaconExpiresAt may be set but isVisible may have been manually
//     //     toggled to false by the user before expiry
//     {
//       $match: {
//         'user.isVisible': true,
//         'user.isActive': true,
//         'user.beaconExpiresAt': { $gt: new Date() }, // beacon must not be expired
//       },
//     },

//     // ── Stage 5: $project — shape the response, redact raw GPS ────────────
//     // This is the privacy-critical stage. We project OUT the raw `coordinates`
//     // field entirely so it never appears in the result set, even accidentally.
//     // Doing this at the database aggregation layer (rather than in application
//     // code) means it is impossible to accidentally leak GPS coordinates via a
//     // logging statement, a forgotten res.json(), or a future code change.
//     //
//     // Nearby users see: distance, zone label, and public profile fields.
//     // They do NOT see: latitude, longitude, accuracy, email, connections list.
//     {
//       $project: {
//         _id: 0,

//         // User identity — safe public fields only
//         userId: '$user._id',
//         name: '$user.name',
//         avatar: '$user.avatar',
//         bio: '$user.bio',
//         tags: '$user.tags',

//         // Zone label (the fuzzy area string, e.g. "Cafeteria")
//         // This is shown in the UI instead of a coordinate
//         zone: 1,

//         // Distance rounded to the nearest metre — used for "~150m away" label.
//         // We deliberately round to avoid implying false precision from fuzzed data.
//         distanceMeters: { $round: ['$distanceMeters', 0] },

//         // Beacon time remaining — lets the UI show "Visible for 23 more minutes"
//         beaconExpiresAt: '$user.beaconExpiresAt',

//         // !! Explicitly excluded — never uncomment these !!
//         // 'coordinates': 0  — raw GPS [lng, lat]
//         // 'accuracy': 0      — device GPS accuracy
//         // 'user.email': 0    — private contact info
//       },
//     },

//     // ── Stage 6: $sort — closest first ────────────────────────────────────
//     // Secondary sort on name provides a stable, consistent ordering when
//     // multiple users are at exactly the same distance (e.g. in the same zone).
//     {
//       $sort: {
//         distanceMeters: 1,
//         name: 1,
//       },
//     },

//     // ── Stage 7: $limit — cap result set ──────────────────────────────────
//     // In a 500-person venue, theoretically everyone could be within 200m.
//     // Capping at 50 keeps the payload manageable and prevents the socket
//     // emit from becoming a megabyte-sized JSON blob.
//     {
//       $limit: limit,
//     },
//   ];

//   return Location.aggregate(pipeline).exec();
// }

// // ── filterOnlineUsers ──────────────────────────────────────────────────────────
// // Takes the results of getNearbyUsers and cross-references each userId against
// // Redis presence keys to determine who is currently connected via a socket.
// //
// // Why this is a separate step (not inside the aggregation):
// //   MongoDB cannot query Redis. We intentionally keep the persistence layer
// //   (MongoDB) and the ephemeral layer (Redis) separate. The aggregation finds
// //   users who WANT to be visible; this function narrows to those who ARE online.
// //
// // @param {Array}  nearbyUsers  - result array from getNearbyUsers
// // @returns {Promise<Array>}    - same array annotated with `isOnline: boolean`
// export async function filterOnlineUsers(nearbyUsers) {
//   if (nearbyUsers.length === 0) return [];

//   // Batch-fetch all presence keys in a single Redis MGET command
//   // instead of N individual GET calls — critical for performance at scale.
//   const presenceKeys = nearbyUsers.map((u) => RedisKeys.presence(u.userId.toString()));
//   const presenceValues = await pubClient.mget(...presenceKeys);

//   // Annotate each user with their online status
//   return nearbyUsers.map((user, index) => ({
//     ...user,
//     isOnline: presenceValues[index] === '1',
//   }));
// }

// // ── getNearbyAndOnlineUsers ────────────────────────────────────────────────────
// // Convenience wrapper that runs both steps in sequence.
// // This is the function called from the socket handler on every location:update.
// //
// // @param {object} options  - same options as getNearbyUsers
// // @returns {Promise<Array>} - filtered, annotated nearby users
// export async function getNearbyAndOnlineUsers(options) {
//   const nearby = await getNearbyUsers(options);
//   return filterOnlineUsers(nearby);
// }

// // ── getZoneSummary ─────────────────────────────────────────────────────────────
// // Returns an aggregated count of visible users per zone — used to render the
// // heatmap / zone density view in the React frontend without exposing individual
// // user identities. Useful for a "hotspots" feature on the main map screen.
// //
// // @param {number} [stalenessSeconds]  - how old a location can be, default 90s
// // @returns {Promise<Array>}           - [{ zone: string, count: number }]
// export async function getZoneSummary(stalenessSeconds = 90) {
//   const cutoff = new Date(Date.now() - stalenessSeconds * 1000);

//   return Location.aggregate([
//     // Only fresh locations
//     {
//       $match: {
//         updatedAt: { $gte: cutoff },
//       },
//     },
//     // Join to check beacon status
//     {
//       $lookup: {
//         from: 'users',
//         localField: 'userId',
//         foreignField: '_id',
//         as: 'user',
//       },
//     },
//     { $unwind: '$user' },
//     // Only count users who are actively beaconing
//     {
//       $match: {
//         'user.isVisible': true,
//         'user.isActive': true,
//         'user.beaconExpiresAt': { $gt: new Date() },
//       },
//     },
//     // Group by zone and count
//     {
//       $group: {
//         _id: '$zone',
//         count: { $sum: 1 },
//       },
//     },
//     // Rename _id to zone for a cleaner API response shape
//     {
//       $project: {
//         _id: 0,
//         userId: 1,
//         distanceMeters: { $round: ['$distanceMeters', 0] },
//         zone: 1,
//         'user.name': 1,
//         'user.avatar': 1,
//         'user._id': 1
//       },
//     },
//     // Most populated zones first
//     {
//       $sort: { count: -1 },
//     },
//   ]).exec();
// }