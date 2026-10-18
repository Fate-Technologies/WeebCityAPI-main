/**
 * Long-lived embedded PostgreSQL for local dev — no Docker or system install.
 * Downloads/uses a real Postgres binary via `embedded-postgres`, keeps it
 * running on localhost:5432 so `prisma db push`, the importer, and the server
 * (run as separate commands) all connect over TCP. Ctrl-C stops it cleanly.
 *
 * Data persists in ./.pgdata so imports survive restarts.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const DATA_DIR = path.resolve('./.pgdata');
const PORT = 5432;
const USER = 'anilist';
const PASSWORD = 'anilist';
const DB = 'anilist';

async function main() {
  const alreadyInitialised = fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    // Force UTF8 so Japanese/native titles store correctly. The Windows default
    // locale would otherwise init the cluster as WIN1252 and reject non-Latin text.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  if (!alreadyInitialised) {
    console.log('Initialising Postgres data dir ...');
    await pg.initialise();
  }

  console.log('Starting Postgres on localhost:%d ...', PORT);
  await pg.start();

  try {
    await pg.createDatabase(DB);
    console.log(`Created database "${DB}".`);
  } catch {
    // already exists
  }

  console.log('Postgres is ready. Leave this running; open another terminal for db:push / import / dev.');
  console.log('Press Ctrl-C to stop.');

  const shutdown = async () => {
    console.log('\nStopping Postgres ...');
    try { await pg.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => { console.error(e); process.exit(1); });
