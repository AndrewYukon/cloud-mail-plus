import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
const user = sqliteTable('user', {
	userId: integer('user_id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull(),
	type: integer('type').default(1).notNull(),
	password: text('password').notNull(),
	salt: text('salt').notNull(),
	status: integer('status').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	activeTime: text('active_time'),
	createIp: text('create_ip'),
	activeIp: text('active_ip'),
	os: text('os'),
	browser: text('browser'),
	device: text('device'),
	sort: text('sort').default(0),
	sendCount: text('send_count').default(0),
	regKeyId: integer('reg_key_id').default(0).notNull(),
	agentEnabled: integer('agent_enabled').default(0).notNull(),
	agentAutoDraft: integer('agent_auto_draft').default(0).notNull(),
	agentPersona: text('agent_persona').default('').notNull(),
	agentProvider: text('agent_provider').default('workers-ai').notNull(),
	agentCfAccountId: text('agent_cf_account_id').default('').notNull(),
	agentAiGatewayId: text('agent_ai_gateway_id').default('').notNull(),
	agentGatewayProvider: text('agent_gateway_provider').default('openai').notNull(),
	agentBaseUrl: text('agent_base_url').default('').notNull(),
	agentApiKey: text('agent_api_key').default('').notNull(),
	agentModel: text('agent_model').default('').notNull(),
	isDel: integer('is_del').default(0).notNull()
});
export default user
