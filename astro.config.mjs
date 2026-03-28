// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  site: 'https://southbaysignal.org',
  trailingSlash: 'never',
  output: 'static',
  adapter: vercel(),
  integrations: [react()],
  vite: {
    // @ts-ignore - tailwindcss/vite type mismatch with astro's bundled vite
    plugins: [tailwindcss()],
    esbuild: {
      jsxInject: `import React from 'react'`,
    },
    server: {
      fs: {
        allow: ['..']
      }
    }
  }
});
