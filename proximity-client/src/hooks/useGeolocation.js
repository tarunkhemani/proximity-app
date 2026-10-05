import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../context/SocketContext';

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

  useEffect(() => {
    if (!navigator.geolocation) {
      setPermissionState('unsupported');
      setError('Geolocation is not supported by your browser.');
    }
  }, []);

  useEffect(() => {
    if (!navigator.permissions?.query) return;

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        setPermissionState(result.state);

        result.addEventListener('change', () => {
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

  useEffect(() => {
    if (permissionState === 'granted') {
      startWatching();
    }
  // startWatching is stable (useCallback with no deps that change), so this
  // effect correctly fires once when permissionState first becomes 'granted'.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionState]);

  const handleSuccess = useCallback((geolocationPosition) => {
    const { latitude, longitude, accuracy } = geolocationPosition.coords;
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

  const startWatching = useCallback(() => {
    if (!navigator.geolocation) return;
    if (watchIdRef.current !== null) {
      return;
    }

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

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (intervalIdRef.current !== null) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
    setIsWatching(false);
    lastPositionRef.current = null;
  }, []);

  useEffect(() => {

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

      if (!current) {
        console.warn('[geo] No GPS fix yet — skipping tick');
        return;
      }

      const { latitude, longitude, accuracy } = current;
      const last = lastPositionRef.current;

      if (last) {
        const moved = haversineDistance(last.latitude, last.longitude, latitude, longitude);
        if (moved < MIN_DISTANCE_METERS) {
          console.warn('[geo] Under movement threshold — skipping emit');
          return;
        }
      }

      emitLocationUpdate({ longitude, latitude, accuracy });
      setLastUpdatedAt(new Date());
      lastPositionRef.current = { latitude, longitude };
    };

    // Fire immediately — handles the case where GPS fix already exists
    doEmit();

    let retryId = null;
    if (!latestPositionRef.current) {
      retryId = setTimeout(() => {
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

  // Only needed when permissionState is 'prompt' (first visit).
  // Returning users with 'granted' state are handled by the auto-start effect.
  const requestPermission = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handleSuccess(pos);
        startWatching();
      },
      handleError,
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
    );
  }, [handleSuccess, handleError, startWatching]);

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

