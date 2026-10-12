import db from '../db/index.js';

interface IncrementResponse {
  totalHits: number;
  resetTime: Date | undefined;
}

interface StoreOptions {
  windowMs: number;
}

export class RateLimitStore {
  private windowMs = 60000;
  private keyPrefix: string;

  get prefix(): string {
    return this.keyPrefix;
  }

  constructor(prefix = '') {
    this.keyPrefix = prefix ? prefix + ':' : '';
  }

  init(options: StoreOptions) {
    this.windowMs = options.windowMs;
  }

  private prefixed(key: string): string {
    return this.keyPrefix + key;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const pk = this.prefixed(key);
    try {
      const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      const resetTime = new Date(Date.now() + this.windowMs);
      const resetStr = resetTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

      // Atomic: insert-or-update in one statement
      await db.prepare(
        `INSERT INTO rate_limits (\`key\`, hits, expires_at) VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE
           hits = IF(expires_at <= ?, 1, hits + 1),
           expires_at = IF(expires_at <= ?, ?, expires_at)`
      ).run(pk, resetStr, now, now, resetStr);

      // Read the current state after atomic upsert
      const row = await db.prepare('SELECT hits, expires_at FROM rate_limits WHERE `key` = ?').get(pk) as any;
      return { totalHits: row?.hits ?? 1, resetTime: new Date(row?.expires_at ?? resetStr) };
    } catch (err) {
      console.error('[RATE-LIMIT] Store unavailable, failing closed:', err);
      // Fail-closed: block request when DB is down (do not allow unlimited brute-force)
      return { totalHits: 999999, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await db.prepare('UPDATE rate_limits SET hits = GREATEST(0, hits - 1) WHERE `key` = ?').run(this.prefixed(key));
    } catch (err) {
      console.error('[RATE-LIMIT] Store unavailable during decrement:', err);
    }
  }

  async resetKey(key: string): Promise<void> {
    await db.prepare('DELETE FROM rate_limits WHERE `key` = ?').run(this.prefixed(key));
  }

  async resetAll(): Promise<void> {
    await db.prepare('DELETE FROM rate_limits').run();
  }

  static async resetExpired(): Promise<void> {
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').run(now);
  }
}

export class SlidingWindowRateLimiter {
  private store: Map<string, { attempts: number[] }> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      entry.attempts = entry.attempts.filter(t => now - t < 3600_000);
      if (entry.attempts.length === 0) this.store.delete(key);
    }
  }

  async increment(key: string, windowMs: number, maxAttempts: number): Promise<{ allowed: boolean; retryAfterMs: number; attempts: number }> {
    const now = Date.now();
    const entry = this.store.get(key) || { attempts: [] };
    entry.attempts = entry.attempts.filter(t => now - t < windowMs);

    if (entry.attempts.length >= maxAttempts) {
      const oldestAttempt = entry.attempts[0]!;
      const retryAfterMs = windowMs - (now - oldestAttempt);
      return { allowed: false, retryAfterMs, attempts: entry.attempts.length };
    }

    entry.attempts.push(now);
    this.store.set(key, entry);
    return { allowed: true, retryAfterMs: 0, attempts: entry.attempts.length };
  }

  async getAttempts(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const entry = this.store.get(key) || { attempts: [] };
    entry.attempts = entry.attempts.filter(t => now - t < windowMs);
    if (entry.attempts.length === 0) {
      this.store.delete(key);
      return 0;
    }
    return entry.attempts.length;
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
