/**
 * `texomodo build`: prepares a project's publish directory.
 *
 *   1. Copies the overlay (launcher, overlay script, stylesheet) into
 *      <site>/<out>/ so the published site can load it. The website source
 *      never contains review code; each page carries one <script> tag.
 *   2. Writes <site>/<out>/config.json from environment variables: PUBLIC
 *      values only (Supabase URL, publishable key, site id, domain hint) plus
 *      build metadata. It refuses to write anything that looks like a secret.
 *
 * Without SUPABASE_URL the public site still builds; Review Mode is then
 * either disabled or (REVIEW_LOCAL_MODE=true) runs on browser storage.
 */
import { writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, isSecretKey, SITE_ID_RE } from './env.mjs';

const overlaySrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');

export function build({ root, siteDir = 'site', outDir = 'review', log = console.log } = {}) {
  const env = loadEnv(root);
  const site = join(root, siteDir);
  if (!existsSync(site)) throw new Error(`build: publish directory "${siteDir}" not found in ${root}`);
  const overlayDst = join(site, outDir);

  // --- 1. overlay files ---------------------------------------------------
  rmSync(overlayDst, { recursive: true, force: true });
  mkdirSync(overlayDst, { recursive: true });
  const copied = readdirSync(overlaySrc).filter((f) => /\.(js|css)$/.test(f));
  for (const f of copied) copyFileSync(join(overlaySrc, f), join(overlayDst, f));

  // --- 2. config ----------------------------------------------------------
  const supabaseUrl = (env.SUPABASE_URL || '').trim();
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();

  if (isSecretKey(anonKey)) {
    throw new Error('build: SUPABASE_ANON_KEY is a secret / service_role key. Use the publishable (anon) key for the browser.');
  }
  if (env.SUPABASE_SERVICE_ROLE_KEY && env.CONTEXT) {
    // CONTEXT is set by Netlify. The secret key must never live there.
    throw new Error('build: SUPABASE_SERVICE_ROLE_KEY is set in the hosting environment. Remove it; it is only for local scripts.');
  }

  let mode = 'disabled';
  if (supabaseUrl && anonKey) mode = 'supabase';
  else if (/^(1|true|yes)$/i.test(env.REVIEW_LOCAL_MODE || '')) mode = 'local';

  const siteId = (env.TEXOMODO_SITE_ID || '').trim().toLowerCase();
  if (mode === 'supabase' && !siteId) {
    throw new Error('build: TEXOMODO_SITE_ID is not set. It names this website in the Supabase project (e.g. TEXOMODO_SITE_ID=allsaints) and must match a row in public.sites.');
  }
  if (siteId && !SITE_ID_RE.test(siteId)) {
    throw new Error(`build: TEXOMODO_SITE_ID "${siteId}" must be 2-63 lowercase letters, digits or dashes.`);
  }

  const config = {
    mode,
    supabaseUrl: mode === 'supabase' ? supabaseUrl : null,
    supabaseAnonKey: mode === 'supabase' ? anonKey : null,
    site: siteId || 'local',
    siteName: (env.TEXOMODO_SITE_NAME || '').trim() || null,
    allowedDomainHint: (env.ALLOWED_GOOGLE_DOMAIN || '').trim() || null,
    // Shows the "Ask AI to change this" button on comment cards. Off until the Phase 2 pipeline exists.
    aiChangeRequests: /^(1|true|yes)$/i.test(env.REVIEW_AI_CHANGES || ''),
    build: {
      commit: env.COMMIT_REF || env.RAILWAY_GIT_COMMIT_SHA || gitSha(root),
      branch: env.BRANCH || env.RAILWAY_GIT_BRANCH || gitBranch(root),
      context: env.CONTEXT || (env.RAILWAY_ENVIRONMENT_NAME ? 'railway:' + env.RAILWAY_ENVIRONMENT_NAME : 'local'),
      deployUrl: env.DEPLOY_PRIME_URL || env.DEPLOY_URL || env.URL || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : null),
      deployId: env.DEPLOY_ID || env.RAILWAY_DEPLOYMENT_ID || null,
      reviewId: env.REVIEW_ID || null, // Netlify deploy-preview number, when any
      builtAt: new Date().toISOString(),
      mainBranch: env.MAIN_BRANCH || 'main',
      // Short SHAs of the commits this deploy contains (newest first). Comments made
      // on any of them belong on this deploy; see docs/review-system.md "Versions".
      ancestors: gitAncestors(root, 400),
    },
  };
  config.build.shallow = config.build.ancestors.length > 0 && gitIsShallow(root);

  writeFileSync(join(overlayDst, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  log(`build: copied ${copied.length} overlay files to ${siteDir}/${outDir}/; wrote config.json (mode=${mode}, site=${config.site}, commit=${(config.build.commit || 'unknown').slice(0, 7)}, branch=${config.build.branch || '?'}, history=${config.build.ancestors.length}${config.build.shallow ? ' shallow' : ''})`);
  if (mode === 'disabled') log('build: SUPABASE_URL / SUPABASE_ANON_KEY not set; Review Mode is disabled on this deploy.');
  return config;
}

// ---------------------------------------------------------------------------
function gitSha(dir) {
  try { return execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
function gitIsShallow(dir) {
  try { return execSync('git rev-parse --is-shallow-repository', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true'; }
  catch { return false; }
}
function gitAncestors(dir, max) {
  try {
    if (gitIsShallow(dir)) {
      // Netlify clones shallowly; a deeper history makes cross-branch visibility accurate.
      try { execSync(`git fetch --deepen=${max} --quiet`, { cwd: dir, stdio: 'ignore', timeout: 60000 }); } catch {}
    }
    return execSync(`git rev-list --max-count=${max} HEAD`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean).map((sha) => sha.slice(0, 7));
  } catch { return []; }
}
function gitBranch(dir) {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
