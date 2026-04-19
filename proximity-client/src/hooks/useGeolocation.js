import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../context/SocketContext';

// ── Configuration ─────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 15_000;
const MIN_DISTANCE_METERS = 0;      // keep 0 for local dev — desktop GPS never moves
const GPS_TIMEOUT_MS      = 10_000;
const GPS_MAX_AGE_MS      = 20_000;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R     = 6_371_000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useGeolocation() {
  const { emitLocationUpdate, beaconActive } = useSocket();

  const [position,        setPosition]        = useState(null);
  const [permissionState, setPermissionState] = useState('prompt');
  const [error,           setError]           = useState(null);
  const [isWatching,      setIsWatching]      = useState(false);
  const [lastUpdatedAt,   setLastUpdatedAt]   = useState(null);

  const lastPositionRef   = useRef(null);
  const watchIdRef        = useRef(null);
  const intervalIdRef     = useRef(null);
  const latestPositionRef = useRef(null);

  // ── Check browser support ──────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) {
      setPermissionState('unsupported');
      setError('Geolocation is not supported by your browser.');
    }
  }, []);

  // ── Query current permission state ─────────────────────────────────────────
  useEffect(() => {
    if (!navigator.permissions?.query) return;

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        console.log('[geo] Permission state from browser:', result.state);
        setPermissionState(result.state);

        result.addEventListener('change', () => {
          console.log('[geo] Permission state changed to:', result.state);
          setPermissionState(result.state);
          if (result.state === 'denied') {
            setError('Location permission was revoked. Please re-enable it in your browser settings.');
            stopWatching();
          }
        });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── THE FIX: auto-start watching when permission is already granted ─────────
  // Without this, a returning user who already granted permission in a previous
  // session never triggers requestPermission() (because the gate button never
  // appears), so startWatching() is never called, isWatching stays false,
  // the emit interval never starts, and zero location:update events are sent.
  useEffect(() => {
    console.log('[geo] Permission state changed — auto-start check:', permissionState);
    if (permissionState === 'granted') {
      console.log('[geo] Permission already granted — auto-starting GPS watch');
      startWatching();
    }
  // startWatching is stable (useCallback with no deps that change), so this
  // effect correctly fires once when permissionState first becomes 'granted'.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionState]);

  // ── GPS event handlers ─────────────────────────────────────────────────────
  const handleSuccess = useCallback((geolocationPosition) => {
    const { latitude, longitude, accuracy } = geolocationPosition.coords;
    console.log('[geo] GPS fix received:', { latitude, longitude, accuracy });
    setPermissionState('granted');
    setError(null);
    latestPositionRef.current = { latitude, longitude, accuracy };
    setPosition({ latitude, longitude, accuracy });
  }, []);

  const handleError = useCallback((geolocationError) => {
    const messages = {
      1: 'Location access denied. Please allow location access to use the radar.',
      2: 'Location unavailable. Try moving to an area with better GPS or WiFi signal.',
      3: 'Location request timed out. Retrying…',
    };
    const msg = messages[geolocationError.code] || 'An unknown location error occurred.';
    setError(msg);
    setPermissionState(geolocationError.code === 1 ? 'denied' : 'error');
    console.warn('[geo] GPS error code', geolocationError.code, ':', geolocationError.message);
  }, []);

  // ── startWatching ──────────────────────────────────────────────────────────
  const startWatching = useCallback(() => {
    if (!navigator.geolocation) return;
    if (watchIdRef.current !== null) {
      console.log('[geo] startWatching called but already watching — skipping');
      return;
    }

    console.log('[geo] Starting GPS watchPosition');
    setIsWatching(true);
    setError(null);

    watchIdRef.current = navigator.geolocation.watchPosition(
      handleSuccess,
      handleError,
      {
        enableHighAccuracy: true,
        timeout:            GPS_TIMEOUT_MS,
        maximumAge:         GPS_MAX_AGE_MS,
      }
    );
  }, [handleSuccess, handleError]);

  // ── stopWatching ───────────────────────────────────────────────────────────
  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      console.log('[geo] GPS watch cleared');
    }
    if (intervalIdRef.current !== null) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
    setIsWatching(false);
    lastPositionRef.current = null;
  }, []);

  // ── Periodic emit loop ─────────────────────────────────────────────────────
  useEffect(() => {
    console.log('[geo] Interval effect — beaconActive:', beaconActive, '| isWatching:', isWatching);

    if (!beaconActive || !isWatching) {
      console.warn('[geo] Interval NOT started — beaconActive:', beaconActive, '| isWatching:', isWatching);
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      return;
    }

    const doEmit = () => {
      const current = latestPositionRef.current;
      console.log('[geo] Interval tick — position:', current);

      if (!current) {
        console.warn('[geo] No GPS fix yet — skipping tick');
        return;
      }

      const { latitude, longitude, accuracy } = current;
      const last = lastPositionRef.current;

      if (last) {
        const moved = haversineDistance(last.latitude, last.longitude, latitude, longitude);
        console.log(`[geo] Moved ${moved.toFixed(2)}m (threshold: ${MIN_DISTANCE_METERS}m)`);
        if (moved < MIN_DISTANCE_METERS) {
          console.warn('[geo] Under movement threshold — skipping emit');
          return;
        }
      }

      console.log('[geo] ✅ Emitting location:update', { longitude, latitude, accuracy });
      emitLocationUpdate({ longitude, latitude, accuracy });
      setLastUpdatedAt(new Date());
      lastPositionRef.current = { latitude, longitude };
    };

    // Fire immediately — handles the case where GPS fix already exists
    doEmit();

    // Retry after 3s if no GPS fix was available on the first tick.
    // The browser watchPosition callback typically resolves within 1-2s,
    // so 3s gives comfortable headroom before the 15s interval takes over.
    let retryId = null;
    if (!latestPositionRef.current) {
      console.log('[geo] No immediate GPS fix — scheduling 3s retry');
      retryId = setTimeout(() => {
        console.log('[geo] 3s retry — position now:', latestPositionRef.current);
        doEmit();
      }, 3_000);
    }

    intervalIdRef.current = setInterval(doEmit, POLL_INTERVAL_MS);

    return () => {
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      if (retryId) clearTimeout(retryId);
    };
  }, [beaconActive, isWatching, emitLocationUpdate]);

  // ── requestPermission — called from a user gesture ─────────────────────────
  // Only needed when permissionState is 'prompt' (first visit).
  // Returning users with 'granted' state are handled by the auto-start effect.
  const requestPermission = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }
    console.log('[geo] requestPermission called — triggering browser prompt');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handleSuccess(pos);
        startWatching();
      },
      handleError,
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
    );
  }, [handleSuccess, handleError, startWatching]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => { stopWatching(); };
  }, [stopWatching]);

  return {
    position,
    permissionState,
    error,
    isWatching,
    lastUpdatedAt,
    requestPermission,
    stopWatching,
    startWatching,
  };
}
// import { useState, useEffect, useRef, useCallback } from 'react';
// import { useSocket } from '../context/SocketContext';

// // ── Configuration ─────────────────────────────────────────────────────────────
// const POLL_INTERVAL_MS    = 15_000;
// const MIN_DISTANCE_METERS = 0;      // 0 during local dev — desktop GPS never moves
//                                     // set back to 10 when testing on a real device
// const GPS_TIMEOUT_MS      = 10_000;
// const GPS_MAX_AGE_MS      = 20_000;

// function haversineDistance(lat1, lon1, lat2, lon2) {
//   const R    = 6_371_000;
//   const toRad = (deg) => (deg * Math.PI) / 180;
//   const dLat  = toRad(lat2 - lat1);
//   const dLon  = toRad(lon2 - lon1);
//   const a =
//     Math.sin(dLat / 2) ** 2 +
//     Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
//   return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
// }

// export function useGeolocation() {
//   const { emitLocationUpdate, beaconActive } = useSocket();

//   const [position,        setPosition]        = useState(null);
//   const [permissionState, setPermissionState] = useState('prompt');
//   const [error,           setError]           = useState(null);
//   const [isWatching,      setIsWatching]      = useState(false);
//   const [lastUpdatedAt,   setLastUpdatedAt]   = useState(null);

//   const lastPositionRef   = useRef(null);
//   const watchIdRef        = useRef(null);
//   const intervalIdRef     = useRef(null);
//   const latestPositionRef = useRef(null);

//   useEffect(() => {
//     if (!navigator.geolocation) {
//       setPermissionState('unsupported');
//       setError('Geolocation is not supported by your browser.');
//     }
//   }, []);

//   useEffect(() => {
//     if (!navigator.permissions?.query) return;

//     navigator.permissions
//       .query({ name: 'geolocation' })
//       .then((result) => {
//         setPermissionState(result.state);
//         result.addEventListener('change', () => {
//           setPermissionState(result.state);
//           if (result.state === 'denied') {
//             setError('Location permission was revoked. Please re-enable it in your browser settings.');
//             stopWatching();
//           }
//         });
//       })
//       .catch(() => {});
//   // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);

//   const handleSuccess = useCallback((geolocationPosition) => {
//     const { latitude, longitude, accuracy } = geolocationPosition.coords;
//     setPermissionState('granted');
//     setError(null);
//     latestPositionRef.current = { latitude, longitude, accuracy };
//     setPosition({ latitude, longitude, accuracy });
//   }, []);

//   const handleError = useCallback((geolocationError) => {
//     const messages = {
//       1: 'Location access denied. Please allow location access to use the radar.',
//       2: 'Location unavailable. Try moving to an area with better GPS or WiFi signal.',
//       3: 'Location request timed out. Retrying…',
//     };
//     const msg = messages[geolocationError.code] || 'An unknown location error occurred.';
//     setError(msg);
//     setPermissionState(geolocationError.code === 1 ? 'denied' : 'error');
//     console.warn('[geo] Error:', geolocationError.code, geolocationError.message);
//   }, []);

//   const startWatching = useCallback(() => {
//     if (!navigator.geolocation) return;
//     if (watchIdRef.current !== null) return;

//     setIsWatching(true);
//     setError(null);

//     watchIdRef.current = navigator.geolocation.watchPosition(
//       handleSuccess,
//       handleError,
//       {
//         enableHighAccuracy: true,
//         timeout:            GPS_TIMEOUT_MS,
//         maximumAge:         GPS_MAX_AGE_MS,
//       }
//     );
//   }, [handleSuccess, handleError]);

//   const stopWatching = useCallback(() => {
//     if (watchIdRef.current !== null) {
//       navigator.geolocation.clearWatch(watchIdRef.current);
//       watchIdRef.current = null;
//     }
//     if (intervalIdRef.current !== null) {
//       clearInterval(intervalIdRef.current);
//       intervalIdRef.current = null;
//     }
//     setIsWatching(false);
//     lastPositionRef.current = null;
//   }, []);

//   // ── Periodic emit loop ─────────────────────────────────────────────────────
//   useEffect(() => {
//     console.log('[geo] Interval effect running — beaconActive:', beaconActive, '| isWatching:', isWatching);

//     if (!beaconActive || !isWatching) {
//       console.warn('[geo] Interval NOT started — beaconActive:', beaconActive, 'isWatching:', isWatching);
//       if (intervalIdRef.current) {
//         clearInterval(intervalIdRef.current);
//         intervalIdRef.current = null;
//       }
//       return;
//     }

//     const doEmit = () => {
//       const current = latestPositionRef.current;
//       console.log('[geo] Interval tick — current position:', current);

//       if (!current) {
//         console.warn('[geo] No GPS fix yet — skipping this tick');
//         return;
//       }

//       const { latitude, longitude, accuracy } = current;
//       const last = lastPositionRef.current;

//       if (last) {
//         const moved = haversineDistance(last.latitude, last.longitude, latitude, longitude);
//         console.log(`[geo] Moved ${moved.toFixed(2)}m since last emit (threshold: ${MIN_DISTANCE_METERS}m)`);
//         if (moved < MIN_DISTANCE_METERS) {
//           console.warn('[geo] Under movement threshold — skipping emit');
//           return;
//         }
//       }

//       console.log('[geo] ✅ Emitting location:update', { longitude, latitude, accuracy });
//       emitLocationUpdate({ longitude, latitude, accuracy });
//       setLastUpdatedAt(new Date());
//       lastPositionRef.current = { latitude, longitude };
//     };

//     // Attempt immediately — works if GPS fix already arrived
//     doEmit();

//     // ── Retry after 3 s if the first attempt found no GPS fix ─────────────
//     // On desktop the first watchPosition callback usually resolves in 1-2s.
//     // Without this retry, a user whose fix arrives after the first tick must
//     // wait a full POLL_INTERVAL_MS (15 s) before their Location doc is written
//     // to MongoDB, making them invisible to others for 15 s after beacon start.
//     let retryId = null;
//     if (!latestPositionRef.current) {
//       console.log('[geo] No immediate GPS fix — scheduling 3s retry');
//       retryId = setTimeout(() => {
//         console.log('[geo] 3s retry firing — position now:', latestPositionRef.current);
//         doEmit();
//       }, 3_000);
//     }

//     intervalIdRef.current = setInterval(doEmit, POLL_INTERVAL_MS);

//     return () => {
//       if (intervalIdRef.current) {
//         clearInterval(intervalIdRef.current);
//         intervalIdRef.current = null;
//       }
//       if (retryId) {
//         clearTimeout(retryId);
//       }
//     };
//   }, [beaconActive, isWatching, emitLocationUpdate]);

//   const requestPermission = useCallback(() => {
//     if (!navigator.geolocation) {
//       setError('Geolocation is not supported by your browser.');
//       return;
//     }
//     navigator.geolocation.getCurrentPosition(
//       (pos) => {
//         handleSuccess(pos);
//         startWatching();
//       },
//       handleError,
//       { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
//     );
//   }, [handleSuccess, handleError, startWatching]);

//   useEffect(() => {
//     return () => { stopWatching(); };
//   }, [stopWatching]);

//   return {
//     position,
//     permissionState,
//     error,
//     isWatching,
//     lastUpdatedAt,
//     requestPermission,
//     stopWatching,
//     startWatching,
//   };
// }
// import { useState, useEffect, useRef, useCallback } from 'react';
// import { useSocket } from '../context/SocketContext';

// // ── Configuration ─────────────────────────────────────────────────────────────
// const POLL_INTERVAL_MS     = 15_000; // emit location every 15s when beacon is active
// const MIN_DISTANCE_METERS  = 0;     // skip emit if user moved less than this (saves battery)
// const GPS_TIMEOUT_MS       = 10_000; // how long to wait for a GPS fix before erroring
// const GPS_MAX_AGE_MS       = 20_000; // accept cached GPS if it's less than 20s old

// // Haversine formula — computes distance in metres between two lat/lng pairs.
// // Used to detect whether the user has moved enough to warrant a new emit.
// function haversineDistance(lat1, lon1, lat2, lon2) {
//   const R = 6_371_000; // Earth radius in metres
//   const toRad = (deg) => (deg * Math.PI) / 180;
//   const dLat = toRad(lat2 - lat1);
//   const dLon = toRad(lon2 - lon1);
//   const a =
//     Math.sin(dLat / 2) ** 2 +
//     Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
//   return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
// }

// // ── Hook ──────────────────────────────────────────────────────────────────────
// //
// // Returns:
// // {
// //   position:        { latitude, longitude, accuracy } | null
// //   permissionState: 'prompt' | 'granted' | 'denied' | 'unsupported' | 'error'
// //   error:           string | null
// //   isWatching:      boolean
// //   lastUpdatedAt:   Date | null
// //   requestPermission: () => void   — call this on a user gesture (button click)
// //   stopWatching:    () => void
// // }
// export function useGeolocation() {
//   const { emitLocationUpdate, beaconActive } = useSocket();

//   const [position,        setPosition]        = useState(null);
//   const [permissionState, setPermissionState] = useState('prompt');
//   const [error,           setError]           = useState(null);
//   const [isWatching,      setIsWatching]      = useState(false);
//   const [lastUpdatedAt,   setLastUpdatedAt]   = useState(null);

//   // Refs so interval callbacks always have fresh values without re-registering
//   const lastPositionRef   = useRef(null); // { latitude, longitude } of last emit
//   const watchIdRef        = useRef(null); // navigator.geolocation.watchPosition ID
//   const intervalIdRef     = useRef(null); // setInterval ID for the periodic emit
//   const latestPositionRef = useRef(null); // most recent raw GeolocationPosition

//   // ── Check browser support once on mount ────────────────────────────────────
//   useEffect(() => {
//     if (!navigator.geolocation) {
//       setPermissionState('unsupported');
//       setError('Geolocation is not supported by your browser.');
//     }
//   }, []);

//   // ── Query current permission state (without triggering a prompt) ────────────
//   useEffect(() => {
//     if (!navigator.permissions?.query) return;

//     navigator.permissions
//       .query({ name: 'geolocation' })
//       .then((result) => {
//         setPermissionState(result.state); // 'granted' | 'denied' | 'prompt'

//         // Listen for permission changes (user toggles in browser settings)
//         result.addEventListener('change', () => {
//           setPermissionState(result.state);
//           if (result.state === 'denied') {
//             setError('Location permission was revoked. Please re-enable it in your browser settings.');
//             stopWatching();
//           }
//         });
//       })
//       .catch(() => {
//         // Permissions API not available — silently continue
//       });
//   // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);

//   // ── Handlers passed to watchPosition ────────────────────────────────────────
//   const handleSuccess = useCallback(
//     (geolocationPosition) => {
//       const { latitude, longitude, accuracy } = geolocationPosition.coords;

//       setPermissionState('granted');
//       setError(null);

//       // Always store the latest raw position
//       latestPositionRef.current = { latitude, longitude, accuracy };

//       setPosition({ latitude, longitude, accuracy });
//     },
//     []
//   );

//   const handleError = useCallback((geolocationError) => {
//     const messages = {
//       1: 'Location access denied. Please allow location access to use the radar.',
//       2: 'Location unavailable. Try moving to an area with better GPS or WiFi signal.',
//       3: 'Location request timed out. Retrying…',
//     };
//     const msg = messages[geolocationError.code] || 'An unknown location error occurred.';
//     setError(msg);
//     setPermissionState(geolocationError.code === 1 ? 'denied' : 'error');
//     console.warn('[geolocation] Error:', geolocationError.code, geolocationError.message);
//   }, []);

//   // ── Core watching logic ────────────────────────────────────────────────────
//   const startWatching = useCallback(() => {
//     if (!navigator.geolocation) return;
//     if (watchIdRef.current !== null) return; // already watching

//     setIsWatching(true);
//     setError(null);

//     // watchPosition fires on:
//     //   a) First fix after calling watchPosition
//     //   b) Significant device movement (OS decides threshold)
//     //   c) Accuracy improvement
//     // It does NOT fire on a fixed interval — that is handled by the setInterval below.
//     watchIdRef.current = navigator.geolocation.watchPosition(
//       handleSuccess,
//       handleError,
//       {
//         enableHighAccuracy: true,  // use GPS chip, not just WiFi/cell triangulation
//         timeout:            GPS_TIMEOUT_MS,
//         maximumAge:         GPS_MAX_AGE_MS,
//       }
//     );
//   }, [handleSuccess, handleError]);

//   const stopWatching = useCallback(() => {
//     if (watchIdRef.current !== null) {
//       navigator.geolocation.clearWatch(watchIdRef.current);
//       watchIdRef.current = null;
//     }
//     if (intervalIdRef.current !== null) {
//       clearInterval(intervalIdRef.current);
//       intervalIdRef.current = null;
//     }
//     setIsWatching(false);
//     lastPositionRef.current = null;
//   }, []);

//   // ── Periodic emit loop ─────────────────────────────────────────────────────
//   // Separate from watchPosition — we do NOT emit every time watchPosition fires
//   // because GPS chips report changes very frequently. Instead, we emit on a
//   // controlled 15-second cadence and only if the user moved > MIN_DISTANCE_METERS.
//   // This is the primary battery-saving mechanism.
//   useEffect(() => {
//   console.log('[geo] Interval effect running — beaconActive:', beaconActive, '| isWatching:', isWatching);

//   if (!beaconActive || !isWatching) {
//     console.warn('[geo] Interval NOT started — beaconActive or isWatching is false');
//     if (intervalIdRef.current) {
//       clearInterval(intervalIdRef.current);
//       intervalIdRef.current = null;
//     }
//     return;
//   }
//   // useEffect(() => {
//   // // 🔍 LOG 1c — confirm the interval is being set up at all
//   // console.log('[geo] Interval effect running — beaconActive:', beaconActive, '| isWatching:', isWatching);

//   // if (!beaconActive || !isWatching) {
//   //   console.warn('[geo] Interval NOT started — beaconActive or isWatching is false');
//   //   if (intervalIdRef.current) {
//   //     clearInterval(intervalIdRef.current);
//   //     intervalIdRef.current = null;
//   //   }
//   //   return;
//   // }
//   // useEffect(() => {
//   //   if (!beaconActive || !isWatching) {
//   //     // If beacon is off, clear any running interval
//   //     if (intervalIdRef.current) {
//   //       clearInterval(intervalIdRef.current);
//   //       intervalIdRef.current = null;
//   //     }
//   //     return;
//   //   }

//     // Emit immediately when beacon turns on (don't wait 15s for first emit)
//   const doEmit = () => {
//     const current = latestPositionRef.current;
//     console.log('[geo] Interval tick — current position:', current);

//     if (!current) {
//       console.warn('[geo] No GPS fix yet — skipping emit');
//       return;
//     }

//     const { latitude, longitude, accuracy } = current;
//     const last = lastPositionRef.current;

//     if (last) {
//       const moved = haversineDistance(last.latitude, last.longitude, latitude, longitude);
//       console.log(`[geo] Moved ${moved.toFixed(2)}m since last emit (threshold: ${MIN_DISTANCE_METERS}m)`);
//       if (moved < MIN_DISTANCE_METERS) {
//         console.warn('[geo] Under movement threshold — skipping emit');
//         return;
//       }
//     }

//     console.log('[geo] ✅ Emitting location:update', { longitude, latitude, accuracy });
//     emitLocationUpdate({ longitude, latitude, accuracy });
//     setLastUpdatedAt(new Date());
//     lastPositionRef.current = { latitude, longitude };
//   };

//   // Try immediately — works if GPS fix is already available
//   doEmit();

//   // ── Retry guard ───────────────────────────────────────────────────────────
//   // If the first doEmit() found no GPS fix (latestPositionRef was null),
//   // schedule a single retry after 3 seconds. On desktop the browser usually
//   // resolves the first watchPosition callback within 1-2 seconds. Without this,
//   // a user whose GPS fix arrives after the first tick has to wait a full
//   // POLL_INTERVAL_MS (15s) for their first location to be written to MongoDB.
//   let retryId = null;
//   if (!latestPositionRef.current) {
//     console.log('[geo] No immediate fix — scheduling 3s retry');
//     retryId = setTimeout(() => {
//       console.log('[geo] Retry firing — position now:', latestPositionRef.current);
//       doEmit();
//     }, 3_000);
//   }

//   intervalIdRef.current = setInterval(doEmit, POLL_INTERVAL_MS);

//   return () => {
//     if (intervalIdRef.current) {
//       clearInterval(intervalIdRef.current);
//       intervalIdRef.current = null;
//     }
//     if (retryId) {
//       clearTimeout(retryId);
//     }
//   };
// }, [beaconActive, isWatching, emitLocationUpdate]);

//   // ── requestPermission — called from a user gesture ─────────────────────────
//   // Browsers require geolocation permission to be triggered by a user action
//   // (a click or tap). Calling getCurrentPosition or watchPosition outside
//   // of a gesture handler will either fail silently or be blocked by the browser.
//   const requestPermission = useCallback(() => {
//     if (!navigator.geolocation) {
//       setError('Geolocation is not supported by your browser.');
//       return;
//     }

//     // A single getCurrentPosition call is enough to trigger the browser prompt.
//     // Once granted, startWatching sets up the persistent watch.
//     navigator.geolocation.getCurrentPosition(
//       (pos) => {
//         handleSuccess(pos);
//         startWatching(); // begin the continuous watch after permission is granted
//       },
//       handleError,
//       { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
//     );
//   }, [handleSuccess, handleError, startWatching]);

//   // ── Cleanup on unmount ─────────────────────────────────────────────────────
//   useEffect(() => {
//     return () => {
//       stopWatching();
//     };
//   }, [stopWatching]);

//   return {
//     position,          // { latitude, longitude, accuracy } | null
//     permissionState,   // 'prompt' | 'granted' | 'denied' | 'unsupported' | 'error'
//     error,             // human-readable error string | null
//     isWatching,        // true while watchPosition is active
//     lastUpdatedAt,     // Date of last successful server emit | null
//     requestPermission, // call this from a button onClick
//     stopWatching,      // call this to fully stop GPS
//     startWatching,     // call this if you want to resume after stopWatching
//   };
// }