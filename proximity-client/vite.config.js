import { defineConfig } from 'vite';
import react            from '@vitejs/plugin-react';
import { VitePWA }      from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      // 'autoUpdate' silently updates the service worker in the background.
      // The user gets the new version on next visit without a prompt.
      registerType: 'autoUpdate',

      // Assets that should be pre-cached by the service worker
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
      ],

      // Web App Manifest — controls how the app looks when installed
      manifest: {
        name:             'Proximity — Find People Nearby',
        short_name:       'Proximity',
        description:      'Real-time proximity networking for events and campuses',
        theme_color:      '#050d1a',
        background_color: '#050d1a',
        display:          'standalone',    // fullscreen, no browser chrome
        orientation:      'portrait',
        scope:            '/',
        start_url:        '/radar',        // deep-link directly to the radar on launch

        icons: [
          {
            src:   'icons/icon-192.png',
            sizes: '192x192',
            type:  'image/png',
          },
          {
            src:   'icons/icon-512.png',
            sizes: '512x512',
            type:  'image/png',
          },
          {
            // Maskable icon — Android uses this for adaptive icon shapes
            src:     'icons/icon-512-maskable.png',
            sizes:   '512x512',
            type:    'image/png',
            purpose: 'maskable',
          },
        ],

        // Shortcuts appear when the user long-presses the home screen icon
        shortcuts: [
          {
            name:       'Open Radar',
            short_name: 'Radar',
            url:        '/radar',
            icons:      [{ src: 'icons/icon-192.png', sizes: '192x192' }],
          },
          {
            name:       'Inbox',
            short_name: 'Inbox',
            url:        '/radar?inbox=1',
            icons:      [{ src: 'icons/icon-192.png', sizes: '192x192' }],
          },
        ],

        // Permissions policy — declare that we use geolocation
        permissions: ['geolocation'],
      },

      workbox: {
        // Serve index.html for all navigation requests that don't match a file
        // (SPA routing). Exclude API and socket.io from the fallback.
        navigateFallback:          '/index.html',
        navigateFallbackDenylist:  [/^\/api/, /^\/socket\.io/],

        // Pre-cache all build output
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

        // Runtime caching rules
        runtimeCaching: [
          // Google Fonts — stale-while-revalidate for stylesheets
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler:    'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
            },
          },
          // Google Fonts — cache-first for the actual font files (they never change)
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler:    'CacheFirst',
            options: {
              cacheName:  'google-fonts-webfonts',
              expiration: {
                maxEntries:    20,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
            },
          },
          // API calls — network-first, no cache
          // Ensures the user always gets fresh data when online.
          {
            urlPattern:    /^\/api\//,
            handler:       'NetworkOnly',
          },
        ],

        // Skip waiting — activate the new service worker immediately
        // instead of waiting for all tabs to close
        skipWaiting:   true,
        clientsClaim:  true,
      },
    }),
  ],

  // ── Dev server proxy ───────────────────────────────────────────────────────
  // Forwards /api and /socket.io to the backend during development so you
  // don't need CORS or a separate port in the browser address bar.
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:       'http://localhost:5000',
        changeOrigin: true,
      },
      '/socket.io': {
        target:       'http://localhost:5000',
        ws:           true,     // enable WebSocket proxying
        changeOrigin: true,
      },
    },
  },

  // ── Production build ───────────────────────────────────────────────────────
  build: {
    // Warn if any chunk exceeds 500kb
    chunkSizeWarningLimit: 500,

    // rollupOptions: {
    //   output: {
    //     // Manual chunk splitting prevents a single giant bundle.
    //     // Each key becomes a separate file that browsers can cache independently.
    //     manualChunks: {
    //       // React core — rarely changes, long cache lifetime
    //       'vendor-react':  ['react', 'react-dom'],
    //       // Router
    //       'vendor-router': ['react-router-dom'],
    //       // Socket.io client — split so it doesn't bloat the main bundle
    //       'vendor-socket': ['socket.io-client'],
    //       // Animation library
    //       'vendor-motion': ['framer-motion'],
    //       // UI utilities
    //       'vendor-ui':     ['lucide-react', 'react-hot-toast', 'axios'],
    //     },
    //   },
    // },
  },
});
// import { defineConfig } from 'vite'
// import react from '@vitejs/plugin-react'
// import tailwindcss from '@tailwindcss/vite'

// // https://vite.dev/config/
// export default defineConfig({
//   plugins: [
//     react(),
//     tailwindcss(),
//   ],
// })