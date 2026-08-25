// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Past-dated /event/ and /events/ URLs stay out of the sitemap — the pages
// themselves keep resolving for ~30 days (grace banner) but crawlers shouldn't
// be steered at them.
const buildDayPt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const isPastDatedUrl = (/** @type {string} */ page) => {
  const m = page.match(/\/events?\/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] < buildDayPt : false;
};

// council-page lastmod: real per-city freshness (last summarized meeting)
// where it's cheap to reach from a src/data JSON already on disk; every other
// URL falls back to the build date, which still beats shipping no <lastmod>.
/** @type {Record<string, string>} */
let govLastmodByCity = {};
try {
  const digestsPath = fileURLToPath(new URL('./src/data/south-bay/digests.json', import.meta.url));
  const digests = JSON.parse(readFileSync(digestsPath, 'utf-8'));
  govLastmodByCity = Object.fromEntries(
    Object.entries(digests).map(([city, d]) => [city, /** @type {{ meetingDateIso?: string }} */ (d).meetingDateIso ?? '']),
  );
} catch {
  // digests.json not present at config-eval time — sitemap just falls back
  // to the build date for /gov/ pages too.
}
const buildDate = new Date().toISOString();

// https://astro.build/config
export default defineConfig({
  site: 'https://southbaytoday.org',
  trailingSlash: 'never',
  output: 'static',
  adapter: vercel(),
  integrations: [react(), sitemap({
    // Newsletter issues live in Blob and are listed at request time by their
    // own sitemap. Keep that sitemap out of the page URL set while including
    // it as a child of the canonical sitemap index.
    customSitemaps: ['https://southbaytoday.org/sitemap-newsletters.xml'],
    filter: (page) => !page.includes('/logo-preview')
      && !page.includes('/admin')
      && !page.endsWith('/sitemap-newsletters.xml')
      && !isPastDatedUrl(page),
    serialize(item) {
      const govMatch = item.url.match(/\/gov\/([a-z-]+)\/?$/);
      const cityLastmod = govMatch ? govLastmodByCity[govMatch[1]] : undefined;
      return { ...item, lastmod: cityLastmod || buildDate };
    },
  })],
  vite: {
    // @ts-ignore - tailwindcss/vite type mismatch with astro's bundled vite
    plugins: [tailwindcss()],
    esbuild: {
      jsxInject: `import React from 'react'`,
    },
    server: {
      fs: {
        // Three levels up so a git worktree at .claude/worktrees/<name> can
        // resolve node_modules from the main project root. From a normal
        // checkout this just whitelists the parent dir, which is harmless.
        allow: ['../../..']
      }
    }
  }
});
