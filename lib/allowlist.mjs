/**
 * `texomodo allowlist`: syncs this site's reviewer list (review_access) from .env:
 *
 *   TEXOMODO_SITE_ID=allsaints                            # which site in the Supabase project
 *   TEXOMODO_SITE_NAME=All Saints Catholic Church         # shown in messages; creates/renames the sites row
 *   ALLOWED_GOOGLE_DOMAIN=example.org
 *   ALLOWED_EMAILS=a@gmail.com, b@outlook.com
 *   ALLOWED_MAINTAINERS=you@example.org          # may verify/resolve/edit anyone's comments on this site
 *   PLATFORM_ADMINS=                             # optional: maintainers on every site (site = NULL rows)
 *
 * Only rows for TEXOMODO_SITE_ID are touched (plus the platform-wide rows when
 * PLATFORM_ADMINS is set). Other sites in the same project are left alone.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Run on a developer machine
 * only; the secret key must never be deployed or shipped to a browser.
 *
 *   texomodo allowlist            # apply: this site's rows not in .env are removed
 *   texomodo allowlist --print    # print the equivalent SQL instead of applying
 */
import { loadEnv, SITE_ID_RE } from './env.mjs';

export async function allowlist({ root, print = false, log = console.log } = {}) {
  const env = loadEnv(root);
  const site = (env.TEXOMODO_SITE_ID || '').trim().toLowerCase();
  const siteName = (env.TEXOMODO_SITE_NAME || '').trim() || site;
  if (!SITE_ID_RE.test(site)) throw new Error('allowlist: TEXOMODO_SITE_ID is required (2-63 lowercase letters, digits or dashes), e.g. TEXOMODO_SITE_ID=allsaints.');

  const domain = (env.ALLOWED_GOOGLE_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');
  const list = (v) => (v || '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
  const emails = list(env.ALLOWED_EMAILS);
  const maintainers = list(env.ALLOWED_MAINTAINERS);
  const platformAdmins = list(env.PLATFORM_ADMINS);
  const managePlatform = platformAdmins.length > 0;

  const desired = [];
  if (domain) desired.push({ site, kind: 'domain', value: domain, role: 'reviewer', note: 'ALLOWED_GOOGLE_DOMAIN' });
  for (const e of emails) if (!maintainers.includes(e)) desired.push({ site, kind: 'email', value: e, role: 'reviewer', note: 'ALLOWED_EMAILS' });
  for (const e of maintainers) desired.push({ site, kind: 'email', value: e, role: 'maintainer', note: 'ALLOWED_MAINTAINERS' });
  for (const e of platformAdmins) desired.push({ site: null, kind: 'email', value: e, role: 'maintainer', note: 'PLATFORM_ADMINS' });
  if (desired.length === 0) throw new Error('allowlist: nothing to sync. Set ALLOWED_GOOGLE_DOMAIN and/or ALLOWED_EMAILS in .env.');

  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  if (print) {
    log('-- Paste into the Supabase SQL editor');
    log(`insert into public.sites (id, name) values (${q(site)}, ${q(siteName)}) on conflict (id) do update set name = excluded.name;`);
    log(`delete from public.review_access where site = ${q(site)};`);
    if (managePlatform) log('delete from public.review_access where site is null;');
    for (const d of desired) {
      log(`insert into public.review_access (site, kind, value, role, note) values (${d.site ? q(d.site) : 'null'}, ${q(d.kind)}, ${q(d.value)}, ${q(d.role)}, ${q(d.note)});`);
    }
    return desired;
  }

  const url = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('allowlist: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or use --print).');

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const endpoint = `${url}/rest/v1/review_access`;
  async function rest(method, target, body, extraHeaders) {
    const res = await fetch(target, { method, headers: { ...headers, ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text();
      const hint = res.status === 404 && /sites/.test(target) ? ' The sites table is missing: run supabase/migrations/0006_sites.sql first.' : '';
      throw new Error(`allowlist: ${method} ${target} -> ${res.status} ${text}${hint}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  // The sites row (migration 0006).
  await rest('POST', `${url}/rest/v1/sites?on_conflict=id`, [{ id: site, name: siteName }], { Prefer: 'resolution=merge-duplicates,return=representation' });

  const scope = managePlatform ? `or=(site.eq.${site},site.is.null)` : `site=eq.${site}`;
  const existing = await rest('GET', `${endpoint}?select=id,site,kind,value,role&${scope}`);
  const keyOf = (r) => `${r.site || ''}:${r.kind}:${r.value.toLowerCase()}`;
  const want = new Map(desired.map((d) => [keyOf(d), d]));
  const have = new Map(existing.map((r) => [keyOf(r), r]));
  const toInsert = desired.filter((d) => !have.has(keyOf(d)));
  const toDelete = existing.filter((r) => !want.has(keyOf(r)));
  const toUpdate = existing.filter((r) => want.has(keyOf(r)) && want.get(keyOf(r)).role !== (r.role || 'reviewer'));

  if (toInsert.length) await rest('POST', endpoint, toInsert);
  for (const r of toDelete) await rest('DELETE', `${endpoint}?id=eq.${r.id}`);
  for (const r of toUpdate) await rest('PATCH', `${endpoint}?id=eq.${r.id}`, { role: want.get(keyOf(r)).role });

  log(`allowlist: site "${site}" (${siteName}): ${toInsert.length} added, ${toDelete.length} removed, ${toUpdate.length} role changes, ${desired.length} total.`);
  for (const d of desired) log(`  ${(d.site || '(all sites)').padEnd(12)} ${d.kind.padEnd(6)} ${d.role.padEnd(10)} ${d.value}`);
  return desired;
}
