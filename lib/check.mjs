/**
 * `texomodo check`: checks a project before it is deployed (no dependencies).
 *   - every page in the publish directory loads the launcher
 *   - the build copies the overlay and writes a sane config.json
 *   - no secrets are tracked by git (.env, service-role / secret keys, GitHub
 *     tokens, Google client secrets, secrets/ folders)
 *   - the generated overlay folder is not tracked
 * A project can run its own checks after this one (see the All Saints repo).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { build } from './build.mjs';
import { isSecretKey, jwtRole } from './env.mjs';

export function check({ root, siteDir = 'site', outDir = 'review', log = console.log } = {}) {
  let failures = 0;
  const ok = (msg) => log(`  ok   ${msg}`);
  const fail = (msg) => { failures++; log(`  FAIL ${msg}`); };

  log('Pages');
  const site = join(root, siteDir);
  const pages = existsSync(site) ? readdirSync(site).filter((f) => f.endsWith('.html')) : [];
  if (!pages.length) fail(`no HTML pages in ${siteDir}/`);
  for (const page of pages) {
    const html = readFileSync(join(site, page), 'utf8');
    if (!html.includes(`${outDir}/review-launcher.js`)) fail(`${page}: missing ${outDir}/review-launcher.js`);
    if (!/<title>[^<]+<\/title>/.test(html)) fail(`${page}: missing <title>`);
  }
  if (pages.length) ok(`${pages.length} pages include the TexoModo launcher`);

  log('Build');
  try {
    const lines = [];
    const cfg = build({ root, siteDir, outDir, log: (l) => lines.push(l) });
    for (const f of ['review-launcher.js', 'review.js', 'review.css']) if (!existsSync(join(site, outDir, f))) fail(`${siteDir}/${outDir}/${f} was not copied`);
    if (existsSync(join(site, outDir, 'types.d.ts'))) fail('types.d.ts should not be published');
    if (!['supabase', 'local', 'disabled'].includes(cfg.mode)) fail(`config.json: unexpected mode ${cfg.mode}`);
    if (cfg.supabaseAnonKey && isSecretKey(cfg.supabaseAnonKey)) fail('config.json contains a secret / service_role key');
    ok(lines[0]);
  } catch (e) {
    fail(`build failed: ${e.message}`);
  }

  log('Secrets');
  const tracked = gitTracked(root);
  if (tracked === null) {
    log('  skip not a git repository');
  } else {
    if (tracked.includes('.env')) fail('.env is tracked by git');
    if (tracked.some((f) => f.startsWith(`${siteDir}/${outDir}/`))) fail(`${siteDir}/${outDir}/ is tracked by git (it is generated at build time)`);
    if (tracked.some((f) => /(^|\/)secrets\//.test(f) || /client_secret.*\.json$/.test(f))) fail('a secrets/ folder or client_secret*.json file is tracked by git');
    for (const f of tracked) {
      if (!/\.(html|js|mjs|json|md|toml|sql|css|txt|csv|yml|yaml)$/.test(f)) continue;
      let text; try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g)) {
        if (jwtRole(m[0]) === 'service_role') fail(`${f}: contains a service_role JWT`);
      }
      if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(text)) fail(`${f}: contains a GitHub token`);
      if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) fail(`${f}: contains a Supabase secret key`);
      if (/"client_secret"\s*:|GOCSPX-[A-Za-z0-9_-]{10,}/.test(text)) fail(`${f}: contains a Google OAuth client secret`);
    }
    if (!failures) ok('no secrets in tracked files');
  }

  log(failures ? `\n${failures} check(s) failed` : '\nTexoModo checks passed');
  return failures;
}

function gitTracked(dir) {
  try { return execFileSync('git', ['ls-files'], { cwd: dir, stdio: 'pipe' }).toString().split('\n').filter(Boolean); }
  catch { return null; }
}
