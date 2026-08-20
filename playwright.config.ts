import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4174',
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'pnpm -C games/demo exec vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174/',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
