import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ============================================================================
 * Per-file test database.
 *
 * `config` resolves DATABASE_PATH once, at import time, so the environment has
 * to be redirected before any engine module is loaded. Vitest runs setup files
 * ahead of the test module graph, which is precisely that moment. Every test
 * file gets its own directory (vitest isolates module state per file) so a test
 * that reseeds the portfolio can never disturb another file's fixture.
 * ==========================================================================*/

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetix-test-'));

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_PATH = path.join(dir, 'kinetix.db');

process.on('exit', () => {
  fs.rmSync(dir, { recursive: true, force: true });
});
