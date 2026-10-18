// Starts MySQL, PostgreSQL and SQL Server in Docker, loads the sample store database, and writes the connection
// details to .tmp/engines.json. Usage: node test/integration/docker.js up | down
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const fixtures = path.join(root, 'test', 'fixtures', 'db');
const PASSWORD = 'Passw0rd!x1';
const engines = {
  mysql: { container: 'dbx-mysql', image: 'mysql:8.4', port: 33306, env: ['-e', `MYSQL_ROOT_PASSWORD=${PASSWORD}`, '-e', 'MYSQL_DATABASE=shop'], inner: 3306 },
  postgres: { container: 'dbx-postgres', image: 'postgres:16', port: 35432, env: ['-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=shop'], inner: 5432 },
  mssql: { container: 'dbx-mssql', image: 'mcr.microsoft.com/mssql/server:2022-latest', port: 31433, env: ['-e', 'ACCEPT_EULA=Y', '-e', `MSSQL_SA_PASSWORD=${PASSWORD}`, '-e', 'MSSQL_PID=Developer'], inner: 1433 },
};

// ENGINES=mysql,postgres limits which servers are started (default: all three).
const wanted = (process.env.ENGINES || 'mysql,postgres,mssql').split(',');
for (const k of Object.keys(engines)) if (!wanted.includes(k)) delete engines[k];

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(label, check, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await sleep(2000);
  }
  throw new Error(`${label} did not become ready in time`);
}

async function up() {
  const info = {};
  for (const [name, e] of Object.entries(engines)) {
    docker(['rm', '-f', e.container]);
    const run = docker(['run', '-d', '--name', e.container, '-p', `127.0.0.1:${e.port}:${e.inner}`, ...e.env, e.image]);
    if (run.code !== 0) throw new Error(`could not start ${name}: ${run.out}`);
    console.log(`started ${name}`);
  }
  if (engines.mysql) await waitUntil('mysql', () => docker(['exec', 'dbx-mysql', 'mysqladmin', 'ping', '-h', '127.0.0.1', `-p${PASSWORD}`, '--silent']).code === 0);
  // The official image restarts once while initialising, so wait for a real query to work.
  if (engines.mysql) await waitUntil('mysql query', () => docker(['exec', 'dbx-mysql', 'mysql', '-uroot', `-p${PASSWORD}`, '-e', 'SELECT 1', 'shop']).code === 0);
  if (engines.postgres) await waitUntil('postgres', () => docker(['exec', 'dbx-postgres', 'psql', '-U', 'postgres', '-d', 'shop', '-c', 'SELECT 1']).code === 0);
  if (engines.mssql) await waitUntil('mssql', () => docker(['exec', 'dbx-mssql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', PASSWORD, '-Q', 'SELECT 1']).code === 0, 120);

  const load = (container, file, shellCommand) => {
    docker(['cp', path.join(fixtures, file), `${container}:/tmp/seed.sql`]);
    const r = docker(['exec', container, 'sh', '-c', shellCommand]);
    if (r.code !== 0) throw new Error(`loading ${file} failed:\n${r.out.slice(-1500)}`);
  };
  if (engines.mysql) load('dbx-mysql', 'mysql.sql', `mysql -uroot -p${PASSWORD} shop < /tmp/seed.sql`);
  if (engines.postgres) load('dbx-postgres', 'postgres.sql', 'psql -U postgres -d shop -v ON_ERROR_STOP=1 -q -f /tmp/seed.sql');
  if (engines.mssql) {
    docker(['exec', 'dbx-mssql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', PASSWORD, '-Q', 'CREATE DATABASE shop']);
    load('dbx-mssql', 'mssql.sql', `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P '${PASSWORD}' -d shop -b -i /tmp/seed.sql`);
  }

  if (engines.mysql) info.mysql = { engine: 'mysql', host: '127.0.0.1', port: engines.mysql.port, database: 'shop', user: 'root', password: PASSWORD };
  if (engines.postgres) info.postgres = { engine: 'postgres', host: '127.0.0.1', port: engines.postgres.port, database: 'shop', user: 'postgres', password: PASSWORD };
  if (engines.mssql) info.mssql = { engine: 'mssql', host: '127.0.0.1', port: engines.mssql.port, database: 'shop', user: 'sa', password: PASSWORD };
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'engines.json'), JSON.stringify(info, null, 2));
  console.log('all three databases are loaded and ready; details in .tmp/engines.json');
}

function down() {
  for (const e of Object.values(engines)) docker(['rm', '-f', e.container]);
  try {
    fs.rmSync(path.join(root, '.tmp', 'engines.json'));
  } catch {
    // already gone
  }
  console.log('containers removed');
}

const cmd = process.argv[2];
(cmd === 'up' ? up() : cmd === 'down' ? Promise.resolve(down()) : Promise.reject(new Error('usage: docker.js up | down'))).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
