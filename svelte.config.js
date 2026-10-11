import { execSync } from 'node:child_process';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** "<commit>[+]@<build time>": "+" marks uncommitted changes (see src/lib/app-version.ts). */
function buildVersion() {
	const builtAt = new Date().toISOString();
	try {
		const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		const dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
		return `${commit}${dirty ? '+' : ''}@${builtAt}`;
	} catch {
		return `unknown@${builtAt}`;
	}
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// The app is a pure SPA: the Gleam server (server/) provides the API and
		// serves this build, using index.html as the fallback for /s/<id> routes.
		adapter: adapter({ fallback: 'index.html' }),
		// Open tabs poll /_app/version.json and offer a reload after a new build.
		// SvelteKit loads this file again in the process that writes the fallback
		// page; the environment carries the name over so both halves agree.
		version: { name: (process.env.YACWU_BUILD_VERSION ||= buildVersion()), pollInterval: 60_000 }
	}
};

export default config;
