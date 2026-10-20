#!/usr/bin/env node
/**
 * texomodo <command> [options]
 *
 *   build       copy the overlay into the publish directory and write config.json
 *   serve       serve the publish directory on $PORT (default 8080)
 *   dev         build, then serve; re-copies the overlay when its source changes.
 *               --local forces browser-only Review Mode (no Supabase) for overlay work.
 *   check       pre-deploy checks (pages, build, secrets)
 *   allowlist   sync this site's reviewer list to Supabase (needs the secret key; local only)
 *
 * Options
 *   --site <dir>   publish directory, default "site"
 *   --out <dir>    folder inside it for the overlay, default "review"
 *   --port <n>     serve/dev port
 *   --print        allowlist: print SQL instead of applying
 *
 * The project root is the current working directory (npm sets it to the
 * package root when run through "npm run").
 */
import { build } from '../lib/build.mjs';
import { serve } from '../lib/serve.mjs';
import { check } from '../lib/check.mjs';
import { allowlist } from '../lib/allowlist.mjs';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-copy the overlay when a file in this package's overlay/ changes (useful when
// the package is linked from a checkout while developing it). Debounced.
function watchOverlay(onChange) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay');
  let timer = null;
  try {
    watch(dir, () => { clearTimeout(timer); timer = setTimeout(onChange, 150); });
    console.log('dev: watching ' + dir + ' for overlay changes');
  } catch { /* watching is best-effort */ }
}

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const root = process.cwd();
const siteDir = opt('site', 'site');
const outDir = opt('out', 'review');

try {
  switch (command) {
    case 'build': build({ root, siteDir, outDir }); break;
    case 'serve': serve({ root, siteDir, port: Number(opt('port', process.env.PORT || 8080)) }); break;
    case 'dev': {
      // --local: browser-only Review Mode (no Supabase), for working on the overlay.
      if (flag('local')) { process.env.REVIEW_LOCAL_MODE = 'true'; process.env.SUPABASE_URL = ''; process.env.SUPABASE_ANON_KEY = ''; }
      build({ root, siteDir, outDir });
      serve({ root, siteDir, port: Number(opt('port', process.env.PORT || 8080)) });
      watchOverlay(() => { try { build({ root, siteDir, outDir, log: (l) => console.log('rebuilt: ' + l.replace(/^build: /, '')) }); } catch (e) { console.error(e.message); } });
      break;
    }
    case 'check': process.exitCode = check({ root, siteDir, outDir }) ? 1 : 0; break;
    case 'allowlist': await allowlist({ root, print: flag('print') }); break;
    default:
      console.log('usage: texomodo <build|serve|dev|check|allowlist> [--site dir] [--out dir] [--port n] [--local] [--print]');
      process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
