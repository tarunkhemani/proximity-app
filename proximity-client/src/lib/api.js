import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// ── Axios instance ─────────────────────────────────────────────────────────
const api = axios.create({
  baseURL:         BASE_URL,
  timeout:         10_000,
  withCredentials: true, // send the httpOnly refresh_token cookie automatically
  headers: {
    'Content-Type': 'application/json',
  },
});

// ── Request interceptor — attach access token ──────────────────────────────
api.interceptors.request.use(
  (config) => {
    // Read the latest token from localStorage on every request.
    // This ensures a freshly refreshed token is used without needing to
    // re-configure the axios instance.
    const token = localStorage.getItem('proximity_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor — handle 401 with token refresh ──────────────────
// Tracks whether a refresh is already in flight to prevent multiple
// simultaneous refresh calls when several requests 401 at the same time.
let isRefreshing    = false;
let refreshQueue    = []; // queued requests waiting for the new token

function processRefreshQueue(newToken, error) {
  refreshQueue.forEach((cb) => (error ? cb.reject(error) : cb.resolve(newToken)));
  refreshQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    // Only intercept 401 responses and avoid infinite retry loops
    if (
      error.response?.status !== 401 ||
      original._retried ||
      original.url === '/auth/refresh' ||
      original.url === '/auth/login'
    ) {
      return Promise.reject(error);
    }

    // If a refresh is already in flight, queue this request
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push({
          resolve: (token) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(api(original));
          },
          reject,
        });
      });
    }

    original._retried = true;
    isRefreshing      = true;

    try {
      // The refresh_token cookie is sent automatically (withCredentials: true)
      const { data } = await api.post('/auth/refresh');
      const newToken = data.accessToken;

      // Persist and propagate the new token
      localStorage.setItem('proximity_token', newToken);
      api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
      original.headers.Authorization = `Bearer ${newToken}`;

      processRefreshQueue(newToken, null);

      // Retry the original failed request with the new token
      return api(original);
    } catch (refreshError) {
      // Refresh failed (expired, revoked) — force logout
      processRefreshQueue(null, refreshError);
      localStorage.removeItem('proximity_token');
      localStorage.removeItem('proximity_user');

      // Redirect to login — use window.location so React Router state is reset
      window.location.href = '/login?reason=session_expired';
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;