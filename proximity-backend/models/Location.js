import mongoose from 'mongoose';

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

const LocationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      // One location document per user — enforced by the unique index below
    },

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

    accuracy: {
      type: Number,
      default: null,
      min: [0, 'Accuracy cannot be negative'],
    },

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

LocationSchema.index({ userId: 1 }, { unique: true });

LocationSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 120,
    name: 'location_ttl',
  }
);

LocationSchema.index({ coordinates: '2dsphere', updatedAt: -1 });

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
