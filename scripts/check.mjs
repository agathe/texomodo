#!/usr/bin/env node
/**
 * Checks for the texomodo repository itself (`npm run check`):
 *   - JavaScript parses
 *   - every table created by a migration has Row Level Security
 *   - the overlay folder holds exactly the files the build copies
 *   - no secrets tracked
 *   - the package builds a throwaway project end to end
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from '../lib/build.mjs';
import { jwtRole } from '../lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };

console.log('JavaScript syntax');
const js = [];
for (const dir of ['bin', 'lib', 'overlay', 'scripts', 'netlify/functions']) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) if (/\.m?js$/.test(f)) js.push(join(abs, f));
}
for (const f of js) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { fail(`${f}: ${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`); }
}
ok(`${js.length} JavaScript files parse`);

console.log('Overlay');
const overlay = readdirSync(join(root, 'overlay')).sort();
const expected = ['review-launcher.js', 'review.css', 'review.js', 'types.d.ts'];
if (overlay.join() !== expected.join()) fail(`overlay/ should contain exactly ${expected.join(', ')} (has ${overlay.join(', ')})`);
else ok('overlay/ holds launcher, overlay, stylesheet and types');

console.log('Database');
for (const f of readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(root, 'supabase/migrations', f), 'utf8');
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  for (const t of tables) if (!new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(sql)) fail(`${f}: RLS not enabled on ${t}`);
  ok(`${f}: RLS enabled on ${tables.join(', ') || '(no new tables)'}`);
}

console.log('Secrets');
const tracked = execFileSync('git', ['ls-files'], { cwd: root }).toString().split('\n').filter(Boolean);
if (tracked.includes('.env')) fail('.env is tracked');
for (const f of tracked) {
  if (!/\.(html|js|mjs|json|md|toml|sql|css|txt)$/.test(f)) continue;
  const text = readFileSync(join(root, f), 'utf8');
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g)) if (jwtRole(m[0]) === 'service_role') fail(`${f}: service_role JWT`);
  if (/sb_secret_[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|GOCSPX-[A-Za-z0-9_-]{10,}/.test(text)) fail(`${f}: contains a secret`);
}
ok('no secrets in tracked files');

console.log('Build (throwaway project)');
const tmp = join(tmpdir(), `texomodo-check-${process.pid}`);
try {
  mkdirSync(join(tmp, 'site'), { recursive: true });
  writeFileSync(join(tmp, 'site/index.html'), '<!doctype html><title>t</title><script src="review/review-launcher.js" defer></script>');
  const lines = [];
  process.env.REVIEW_LOCAL_MODE = 'true';
  const cfg = build({ root: tmp, log: (l) => lines.push(l) });
  if (cfg.mode !== 'local') fail(`expected local mode, got ${cfg.mode}`);
  for (const f of ['review-launcher.js', 'review.js', 'review.css', 'config.json']) if (!existsSync(join(tmp, 'site/review', f))) fail(`${f} not written`);
  ok(lines[0]);
} catch (e) {
  fail(`build failed: ${e.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
