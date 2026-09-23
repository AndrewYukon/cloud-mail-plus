import { defineConfig } from 'vitest/config';

// Pure-function unit tests that need no Workers runtime.
export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'test/unit/**/*.spec.js',
			'test/utils/**/*.test.js',
			'test/agent-config.test.js',
		],
	},
});
