import { config } from '../config.ts';
import { closeDatabase, openDatabase, resetDatabase } from './db.ts';

/* `npm run seed` — wipes local state and reseeds it from the design figures. */

const reset = process.argv.includes('--reset');
const db = reset ? resetDatabase() : openDatabase();

const counts = {
  strategies: (db.prepare('SELECT COUNT(*) AS n FROM strategies').get() as { n: number }).n,
  bots: (db.prepare('SELECT COUNT(*) AS n FROM bots').get() as { n: number }).n,
  positions: (db.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n,
  guardrails: (db.prepare('SELECT COUNT(*) AS n FROM guardrails').get() as { n: number }).n,
  venues: (db.prepare('SELECT COUNT(*) AS n FROM venues').get() as { n: number }).n,
};

console.log(`Database: ${config.db.path}`);
console.log(reset ? 'Mode: reset + reseed' : 'Mode: migrate + seed if empty');
console.table(counts);

closeDatabase();
