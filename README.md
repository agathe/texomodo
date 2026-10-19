# TexoModo

Review Mode for static websites. A reviewer opens the site, clicks "Comment / Review", signs in with Google, and leaves comments anchored to elements, drawn shapes or whole components, at phone, tablet or desktop widths. Maintainers verify, resolve and track every change. Comments live in Supabase, scoped per site, protected by Row Level Security. The public site is untouched: one script tag per page, nothing loaded until the button is clicked.

Site: https://texomodo.com. Status: private beta, used on the All Saints Catholic Church redesign prototype.

## What is in this repo

| Path | Purpose |
|---|---|
| `overlay/` | The browser code: `review-launcher.js` (the only file a page loads), `review.js` (the overlay), `review.css`, `types.d.ts` |
| `lib/`, `bin/` | The `texomodo` command: `build`, `serve`, `dev`, `check`, `allowlist` |
| `supabase/migrations/` | Database schema: sites, allowlist, annotations, replies, events, change requests, storage, realtime. Run in order. |
| `netlify/functions/` | `change-request` stub, the Phase 2 extension point (annotation → AI → branch → PR → preview) |
| `docs/` | `review-system.md` (architecture, setup, security), `ai-change-requests.md` (Phase 2 design) |
| `www/` | The texomodo.com landing page (Netlify publish directory of this repo) |
| `.env.example` | Template for a project's `.env` |

## Using it on a website

A project is a repo with a publish directory (`site/` by default) of static pages.

1. Add the dependency and scripts to the project's `package.json`:

   ```json
   {
     "dependencies": { "texomodo": "github:agathe/texomodo#v0.1.0" },
     "scripts": { "build": "texomodo build", "dev": "texomodo dev", "check": "texomodo check", "allowlist": "texomodo allowlist" }
   }
   ```

2. Put one tag on every page, before `</body>`: `<script src="review/review-launcher.js" defer></script>`. Optionally mark shared blocks with `data-component="site-header"` and the like, so comments on the header appear on every page.
3. Copy `.env.example` to `.env` and fill it in: the Supabase URL and publishable key, a `SITE_ID`, the reviewer domain / emails / maintainers, and the secret key (local only). Run `npm run allowlist` once: it creates the site in the database and its reviewer list.
4. Deploy. On Netlify: build command `npm run build`, publish `site`, environment variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SITE_ID`, `SITE_NAME`, `ALLOWED_GOOGLE_DOMAIN`. Never the secret key.

One Supabase project and one Google OAuth client serve any number of sites. Setup for both is in `docs/review-system.md`.

## Developing TexoModo itself

No dependencies. Node 18 or newer.

```bash
npm run check                 # syntax, RLS on every table, overlay files, secrets, a throwaway build
```

To work on the overlay against a real site, link this folder into the project: in the project, `npm link ../texomodo` (or a `node_modules/texomodo` symlink), then `npm run dev` there.

## Security in one paragraph

The browser holds only the publishable key. Every table and the screenshot bucket have Row Level Security keyed on a signed-in Google account that is on the site's allowlist; the allowlist is readable only by SECURITY DEFINER functions. Author identity, verification and resolution stamps and the activity log are set inside the database from the token, not by the client. The secret key is used by `texomodo allowlist` on a developer machine and never deployed; the build fails if it finds one in a hosting environment. Details and the remaining hardening list: `docs/review-system.md`.
