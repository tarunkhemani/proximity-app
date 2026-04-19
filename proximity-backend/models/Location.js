import mongoose from 'mongoose';

// ── Fuzzy zone definitions ────────────────────────────────────────────────────
// These are the human-readable zone labels shown to nearby users.
// Crucially, these are derived SERVER-SIDE by snapping the user's raw GPS
// coordinate to the nearest zone centroid — the client never receives or
// stores raw coordinates of other users.
//
// Extend this list to match your specific venue (campus map, conference floor
// plan, etc.). The centroid coordinates here are examples — replace them with
// your actual venue's coordinates.
export const FUZZY_ZONES = {
  CS_BLOCK: {
    label: 'CS Block',
    // Centroid: the GPS point that represents this zone for snapping purposes
    centroid: [78.0121, 27.1892], // [longitude, latitude]
  },
  MAIN_AUDITORIUM: {
    label: 'Main Auditorium',
    centroid: [78.0134, 27.1901],
  },
  CAFETERIA: {
    label: 'Cafeteria',
    centroid: [78.0109, 27.1885],
  },
  LIBRARY: {
    label: 'Library',
    centroid: [78.0118, 27.1878],
  },
  LAB_WING: {
    label: 'Lab Wing',
    centroid: [78.0127, 27.1869],
  },
  OPEN_GROUNDS: {
    label: 'Open Grounds',
    centroid: [78.0098, 27.1860],
  },
  MAIN_ENTRANCE: {
    label: 'Main Entrance',
    centroid: [78.0090, 27.1855],
  },
  HACKATHON_HALL: {
    label: 'Hackathon Hall',
    centroid: [78.0142, 27.1910],
  },
};

export const VALID_ZONE_LABELS = Object.values(FUZZY_ZONES).map((z) => z.label);

// ── Schema ────────────────────────────────────────────────────────────────────
const LocationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      // One location document per user — enforced by the unique index below
    },

    // ── GeoJSON Point ─────────────────────────────────────────────────────────
    // MongoDB requires this EXACT nested structure for 2dsphere indexing.
    //
    // ⚠️  COORDINATE ORDER: MongoDB GeoJSON is [longitude, latitude] — the
    //     reverse of what most people expect from GPS. This is the single most
    //     common source of silent bugs in geospatial apps. The 2dsphere index
    //     will accept either order but your $near queries will return wrong
    //     results if you accidentally swap them.
    //
    //     Example — Meerut, UP, India:
    //       Latitude:  28.9845° N  → second element
    //       Longitude: 77.7064° E  → first element
    //       Stored as: [77.7064, 28.9845] ✓
    coordinates: {
      type: {
        type: String,
        enum: {
          values: ['Point'],
          message: 'coordinates.type must be "Point"',
        },
        required: [true, 'GeoJSON type is required'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: [true, 'Coordinate array [longitude, latitude] is required'],
        validate: [
          {
            // Must be exactly a [longitude, latitude] pair
            validator: (arr) => arr.length === 2,
            message: 'coordinates must be a [longitude, latitude] pair',
          },
          {
            // Longitude: -180 to 180
            validator: (arr) => arr[0] >= -180 && arr[0] <= 180,
            message: 'Longitude must be between -180 and 180',
          },
          {
            // Latitude: -90 to 90
            validator: (arr) => arr[1] >= -90 && arr[1] <= 90,
            message: 'Latitude must be between -90 and 90',
          },
        ],
      },
    },

    // ── Fuzzy zone label ──────────────────────────────────────────────────────
    // The zone string derived from the user's GPS coordinate.
    // This is what other users see — never the raw GPS coordinate.
    zone: {
      type: String,
      required: [true, 'zone is required'],
      enum: {
        values: VALID_ZONE_LABELS,
        message: `zone must be one of: ${VALID_ZONE_LABELS.join(', ')}`,
      },
    },

    // ── Accuracy metadata ─────────────────────────────────────────────────────
    // GPS accuracy in metres reported by the browser/device.
    // Stored for analytics — not exposed to other users.
    // High values (>50m) indicate unreliable indoor GPS and can be used to
    // switch to a fallback (WiFi positioning, manual zone selection).
    accuracy: {
      type: Number,
      default: null,
      min: [0, 'Accuracy cannot be negative'],
    },

    // ── TTL / expiry field ────────────────────────────────────────────────────
    // updatedAt drives two critical behaviours:
    //
    // 1. TTL index (120 seconds): MongoDB automatically deletes this document
    //    when updatedAt is more than 120 seconds old. This handles the case
    //    where a user closes the app without explicitly stopping their beacon —
    //    their location document simply disappears from the collection.
    //    Consequence: clients MUST emit location:update at least every 90s to
    //    keep their document alive (we use 15s in the socket handler, so there
    //    is comfortable headroom).
    //
    // 2. Query filter in $geoNear: the aggregation pipeline filters
    //    updatedAt >= (now - 90s) to exclude stale documents that haven't been
    //    cleaned up by the TTL index yet (TTL scans run every ~60 seconds,
    //    so there is a window where a stale document may still exist).
    updatedAt: {
      type: Date,
      default: Date.now,
      // !! Do NOT rename this field — the TTL index below is keyed to it !!
    },
  },
  {
    // Disable automatic timestamps — we manage updatedAt manually so we can
    // control the TTL index behaviour precisely.
    timestamps: false,

    // Optimise for write-heavy workload: location documents are upserted on
    // every location:update event. Lean reads are faster for the aggregation.
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// 2dsphere index — MANDATORY for $geoNear, $near, $geoWithin to function.
// Must be on the field holding the GeoJSON object, not on the nested
// coordinates array. MongoDB traverses the GeoJSON structure automatically.
// LocationSchema.index({ coordinates: '2dsphere' });

// One location document per user — prevents duplicate rows on rapid updates.
// findOneAndUpdate with { upsert: true } relies on this to update-in-place
// rather than inserting a second document.
LocationSchema.index({ userId: 1 }, { unique: true });

// TTL index — MongoDB deletes documents where updatedAt is older than 120 seconds.
// The TTL background task runs approximately every 60 seconds, so actual
// deletion may lag by up to 60s. The query-side cutoff (90s) compensates for this.
// expireAfterSeconds: 0 combined with updatedAt as the field means the document
// expires AT the time stored in updatedAt + 120s.
LocationSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 120,
    name: 'location_ttl',
  }
);

// Compound index for the $geoNear pipeline's internal sort + filter.
// Including updatedAt here lets MongoDB satisfy both the geospatial filter
// and the staleness check from a single index scan.
LocationSchema.index({ coordinates: '2dsphere', updatedAt: -1 });

// ── Static helpers ────────────────────────────────────────────────────────────

// snapToZone: given a raw [longitude, latitude] pair, returns the label of
// the nearest predefined fuzzy zone using the Haversine approximation.
//
// This runs SERVER-SIDE on every location:update event so:
//   a) clients cannot self-report a false zone
//   b) raw GPS coordinates are never stored in the zone field
//
// For a real deployment you would expand FUZZY_ZONES with your venue's
// actual zone centroids surveyed from Google Maps / a site walkthrough.
LocationSchema.statics.snapToZone = function (longitude, latitude) {
  let nearestZone = null;
  let minDistance = Infinity;

  for (const zone of Object.values(FUZZY_ZONES)) {
    const [zoneLng, zoneLat] = zone.centroid;
    // Flat-earth approximation — accurate enough for distances < 1km
    const dLng = (longitude - zoneLng) * Math.cos((latitude * Math.PI) / 180);
    const dLat = latitude - zoneLat;
    // Result is in degrees; we compare relative magnitudes so units don't matter
    const distanceSq = dLng * dLng + dLat * dLat;

    if (distanceSq < minDistance) {
      minDistance = distanceSq;
      nearestZone = zone.label;
    }
  }

  return nearestZone; // always returns something — falls back to closest zone
};

// upsertLocation: the single write path for location updates.
// Always use this instead of raw .findOneAndUpdate() calls so the zone
// snapping and field normalisation happen consistently.
LocationSchema.statics.upsertLocation = async function ({ userId, longitude, latitude, accuracy }) {
  const zone = this.snapToZone(longitude, latitude);
  const now = new Date();

  return this.findOneAndUpdate(
    { userId },
    {
      $set: {
        coordinates: {
          type: 'Point',
          coordinates: [longitude, latitude], // [lng, lat] — GeoJSON order
        },
        zone,
        accuracy: accuracy ?? null,
        updatedAt: now, // refresh TTL clock on every update
      },
    },
    {
      upsert: true,      // create if doesn't exist, update if it does
      new: true,         // return the updated document
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );
};

const Location = mongoose.model('Location', LocationSchema);

export default Location;