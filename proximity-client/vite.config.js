import { defineConfig } from 'vite';
import react            from '@vitejs/plugin-react';
import tailwindcss      from '@tailwindcss/vite';
import { VitePWA }      from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
      ],
      manifest: {
        name:             'Proximity — Find People Nearby',
        short_name:       'Proximity',
        description:      'Real-time proximity networking for events and campuses',
        theme_color:      '#050d1a',
        background_color: '#050d1a',
        display:          'standalone',
        orientation:      'portrait',
        scope:            '/',
        start_url:        '/radar',

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
        ],
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
        permissions: ['geolocation'],
      },

      workbox: {
        navigateFallback:          '/index.html',
        navigateFallbackDenylist:  [/^\/api/, /^\/socket\.io/],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler:    'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
            },
          },
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
          {
            urlPattern:    /^\/api\//,
            handler:       'NetworkOnly',
          },
        ],
        skipWaiting:   true,
        clientsClaim:  true,
      },
    }),
  ],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:       'http://localhost:5000',
        changeOrigin: true,
      },
      '/socket.io': {
        target:       'http://localhost:5000',
        ws:           true,
        changeOrigin: true,
      },
    },
  },

  build: {
    chunkSizeWarningLimit: 600,
    // Note: manualChunks is intentionally removed to prevent Vite 8 from crashing
  },
});

