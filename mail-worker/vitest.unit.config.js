import { defineConfig } from 'vitest/config';

// Pure-function unit tests that need no Workers runtime.
export default defineConfig({
	test: {
		include: ['test/unit/**/*.spec.js'],
		environment: 'node',
	},
});
