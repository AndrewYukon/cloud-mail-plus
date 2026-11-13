import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export function createTestDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE email (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			send_email TEXT,
			name TEXT,
			account_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			subject TEXT,
			text TEXT,
			content TEXT,
			cc TEXT DEFAULT '[]',
			bcc TEXT DEFAULT '[]',
			recipient TEXT,
			to_email TEXT NOT NULL DEFAULT '',
			to_name TEXT NOT NULL DEFAULT '',
			in_reply_to TEXT DEFAULT '',
			relation TEXT DEFAULT '',
			message_id TEXT DEFAULT '',
			type INTEGER NOT NULL DEFAULT 0,
			status INTEGER NOT NULL DEFAULT 0,
			resend_email_id TEXT,
			message TEXT,
			unread INTEGER NOT NULL DEFAULT 0,
			create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			ai_metadata TEXT NOT NULL DEFAULT '',
			folder INTEGER NOT NULL DEFAULT 0,
			is_del INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE email_translation (
			email_id INTEGER NOT NULL,
			target_lang TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			translated_subject TEXT NOT NULL,
			translated_content TEXT NOT NULL,
			source_lang TEXT,
			model TEXT NOT NULL,
			create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (email_id, target_lang)
		);
	`);
	const db = drizzle(sqlite);
	return { sqlite, db };
}
