import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Integration tests run in workerd with only the bindings they need. Pointing
// the pool at a full wrangler config would require the built frontend assets
// and every production binding (Durable Objects, email, queues).
// Pure-function tests live in test/unit and run under vitest.unit.config.js.
export default defineWorkersConfig({
	test: {
		include: ['test/integration/**/*.spec.js'],
		poolOptions: {
			workers: {
				singleWorker: true,
				miniflare: {
					compatibilityDate: '2025-06-04',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['db'],
					kvNamespaces: ['kv'],
					bindings: { domain: '["example.com","example.org"]' },
				},
			},
		},
	},
});
