import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
import { resolveTestDbConfig } from './test-db.js';

// Data tables that must be emptied between runs. Schema (and the migration log) is kept:
// the app applies schema.sql + migrations on boot, and a reset makes every run start
// from the same known state instead of inheriting 1000+ rows and rate-limit counters.
const DATA_TABLES = [
  'activity_logs', 'api_audit_log', 'api_cache', 'attendance', 'token_blacklist',
  'rate_limits', 'refresh_tokens', 'leaves', 'leave_carryforwards', 'leave_balances',
  'holiday_assignees', 'holidays', 'document_requests', 'notifications', 'tasks',
  'task_comments', 'plans', 'plan_items', 'reports', 'report_feedback', 'team_members',
  'teams', 'monthly_overtime', 'files', 'users',
];

export async function resetTestDatabase(): Promise<{ database: string; tables: number }> {
  const cfg = resolveTestDbConfig();
  const connection = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
  });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${cfg.database}\``);
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    let cleared = 0;
    for (const table of DATA_TABLES) {
      const [existing] = await connection.query(
        `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [cfg.database, table]
      );
      const rows = (existing as unknown as Array<{ c: number }>)[0];
      if (!rows || rows.c === 0) continue;
      await connection.query(`TRUNCATE TABLE \`${table}\``);
      cleared += 1;
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    return { database: cfg.database, tables: cleared };
  } finally {
    await connection.end();
  }
}

// Runs once before all test files (separate process).
// Creates the test database and clears leftovers from previous runs.
export default async function globalSetup() {
  try {
    const result = await resetTestDatabase();
    console.log(`[TestSetup] ${result.database} ready (cleared ${result.tables} tables)`);
  } catch (e: any) {
    // Fail loudly: a silently skipped setup shows up much later as a confusing
    // connection error, or (worse) as tests silently running against another DB.
    throw new Error(`[TestSetup] Could not prepare the test database: ${e.message}`);
  }
}
