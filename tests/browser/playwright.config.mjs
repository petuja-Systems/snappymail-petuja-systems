import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.mjs',
	outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR
		|| path.join(os.tmpdir(), 'petuja-email-login-layout', String(process.pid)),
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 15 * 60_000,
	reporter: 'list',
	preserveOutput: 'always',
	use: {
		viewport: { width: 375, height: 667 },
		hasTouch: true,
		reducedMotion: 'reduce',
		serviceWorkers: 'block',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium', isMobile: true } },
		// Firefox does not support Playwright's isMobile context option.
		{ name: 'firefox', use: { browserName: 'firefox' } },
		{ name: 'webkit', use: { browserName: 'webkit', isMobile: true } }
	]
});
