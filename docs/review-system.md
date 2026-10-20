# TexoModo Review Mode: architecture and setup

TexoModo (texomodo.com) adds a Review Mode to a static website: authorized reviewers annotate the live pages and discuss changes without the public site changing at all. This document covers the architecture, setup and security of the tool; a project that uses it (for example the All Saints prototype) keeps its own docs about the website.

## Architecture

```
Public visitor                         Reviewer
──────────────                         ────────
page.html                              page.html
  └─ review/review-launcher.js (3 KB)    └─ review-launcher.js
       adds the "Comment / Review"            └─ loads review.css + review.js
       button; nothing else                        └─ loads @supabase/supabase-js (CDN, pinned)
                                                   └─ Google sign-in → Supabase Auth
                                                   └─ rpc review_is_authorized()
                                                   └─ annotations / replies (Postgres, RLS)
                                                   └─ screenshots (private bucket, signed URLs)
                                                   └─ realtime channel per page
```

- **Public site:** unchanged except one deferred script tag per page. The tag's `data-position` (`bottom-right` default, `bottom-left`, `top-right`, `top-left`) and `data-offset` (px, default 16) attributes place the button; a site can also restyle `#tm-launch` in its own CSS. If anything in the launcher fails, the page still renders (everything is in try/catch). Nothing is fetched until the button is clicked, unless the URL carries `?review=<id>` or the reviewer was already in Review Mode on the previous page (session flag).
- **Overlay (`overlay/review.js`):** vanilla JS, no build step. Toolbar (Pin, Rectangle, Circle, Draw, Comments, Exit), a document-sized annotation layer, and a right-hand drawer. All text is rendered with `textContent`. Styles are prefixed `tm-` and never touch page elements (except a temporary outline when a comment is focused).
- **Layout:** the website lives in `site/` (the publish directory); the overlay source lives in the texomodo package (`overlay/`). `texomodo build` copies the overlay into `site/review/` and writes the config there, so the website folder contains no review code except one script tag per page. That keeps the overlay separable (its own repo or package later).
- **Config (`site/review/config.json`):** generated at build time by `texomodo build` from environment variables. Contains only public values (Supabase URL, anon key, site id and name, domain hint) and build metadata (commit, branch, Netlify context, deploy URL). Not committed.
- **Backend:** Supabase. Google OAuth through Supabase Auth; tables `sites`, `review_access`, `annotations`, `annotation_replies`, `annotation_events`, `change_requests` with Row Level Security; a private Storage bucket for screenshots; realtime on the comment tables. Schema: `supabase/migrations/` (run in order).
- **Authorization:** the `review_access` table holds domains and emails per site. `review_is_authorized(site_id)` is a SECURITY DEFINER function used by every RLS policy, so hiding the toolbar is cosmetic and the database is the gate. The browser cannot read the allowlist. It is managed from `.env` with `npm run allowlist`.
- **Sites:** one Supabase project (and one Google OAuth client) can serve several websites. Each deploy is built with a `TEXOMODO_SITE_ID`; every comment, policy and screenshot path is scoped by it. See "Sites" below.
- **Netlify:** publishes `site/` only, so `docs/`, `data/`, `supabase/` and `scripts/` are never deployed; the build command runs `texomodo build`; a stub function `change-request` reserves the Phase 2 endpoint.
- **Other hosts:** `npm run build` then `npm start` serves `site/` on `$PORT` (works on Railway or any Node host). Build metadata falls back from Netlify's variables to Railway's (`RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_PUBLIC_DOMAIN`) and then to local git.

### What an annotation captures

See `overlay/types.d.ts`. In short: page path, URL, title; type and geometry (anchor selector + fractional coordinates, plus absolute document pixels as fallback); viewport and scroll; the target element (unique selector, tag, id, classes, landmark, nearest heading, readable path, visible text, surrounding block text, selected text, a capped HTML snippet, bounding rect); a cropped screenshot; author; status; replies; build metadata (commit SHA, branch, Netlify context and deploy URL).

Length caps keep records small: element text 300 chars, nearby text 500, HTML 1,500, comment 5,000, screenshot JPEG of at most 1,400 px wide.

### Roles, status flow, editing and the activity log

**Roles** come from the allowlist: every allowed account is a `reviewer`; emails listed in `ALLOWED_MAINTAINERS` are `maintainer` (`review_access.role`, read by `review_role()`). Reviewers edit their own comments and replies and may resolve their own comments. Maintainers edit anyone's text, scope, category and sizes, re-anchor any comment, verify, resolve, reopen and delete. The database triggers enforce this; the UI only reflects it.

**Status flow:** `open` → `verified` → `resolved`, with a resolution of `addressed` (done) or `declined` (will not be done). "Verified" means a maintainer has confirmed the target, scope and sizes and the comment is ready to be worked on; maintainers see an "n awaiting verification" note. Reopen is always possible and clears verification. The Open tab lists open and verified comments. Only verified comments can become AI change requests (database policy).

**Editing:** "Edit text" on a comment, "Edit" on your own reply, and in advanced mode "Edit details" (Applies to, About, Sizes) and "Move mark: Pin · Inspect · Rectangle · Circle · Draw", which re-anchors the comment with that tool and replaces the screenshot while keeping the text and thread. The card shows "edited" with who and when on hover.

**Activity log:** every change is written to `annotation_events` by database triggers (created, edited, moved, metadata changes with from/to, verified, resolved with outcome, reopened, replied, reply edited or deleted), with the actor and time. Clients can only read it. Each card has an "Activity (n)" toggle showing the log newest first.

### Sites: several websites on one Supabase project

Every review row belongs to a **site** (`sites.id`, a short slug such as `allsaints`). The deploy says which site it is through the `TEXOMODO_SITE_ID` environment variable, which `texomodo build` writes into `config.json`; the overlay sends it with every query and the policies check it on every row. Nothing in the UI changes for reviewers.

- **Allowlist per site.** `review_access.site` says which site a row grants. A reviewer for one parish never learns the other parish's site exists: the "not authorized" dialog is the same as for an unknown account. Roles are per site too, so someone can be maintainer on one site and reviewer on another.
- **Platform admins.** A row with `site = NULL` grants every site. `PLATFORM_ADMINS` in `.env` manages those rows; leave it empty in a site's own repo so one site cannot remove another's admins.
- **Screenshots** live under `<site>/<page>/<id>.jpg`; the storage policies read the first folder of the object path.
- **Realtime** subscribes per site. Comments for other sites are never delivered (RLS applies to realtime).
- **Adding a website:** deploy its repo with the same `SUPABASE_URL` / `SUPABASE_ANON_KEY` and a new `TEXOMODO_SITE_ID`, add its domains to the Supabase redirect allowlist, then from that repo set its allowlist in `.env` and run `npm run allowlist` (which creates the `sites` row). The Google consent screen is shared, so name it after the platform rather than one parish.
- **Phase 2:** the change-request pipeline maps `site` to a repository; `change_requests` reaches the site through its annotation (`review_annotation_site()`).
- **Functions** take `site_id` (never a parameter named `site`: in a SQL function a column of the same name would win over the parameter and the check would be void). `review_sites()` lists the sites the caller may review, for a future switcher.

### Versions: which deployment shows which comments

Every comment records the build it was made on (`build`: commit, branch, Netlify context, deploy URL). Each deployment's config carries its own commit, branch and the short SHAs of the commits it contains (`build.ancestors`, written by `texomodo build` from `git rev-list`, up to 400; Netlify's shallow clone is deepened first).

The rule: **a comment is shown on a deployment when the commit it was made on is in that deployment's history**, or when it was made on the same branch. So an iteration branch cut from main shows main's comments and its own; once the branch is merged, its comments appear on main automatically; a branch that is a different site shares no commits and shows only its own. Without history (very shallow clone, no git), the fallback is: same branch, plus the main branch as the baseline.

What reviewers see: a chip on comments from another branch or build ("main · 3 commits ago", "branch fix-nav", "not in this deploy"); counts and markers only include comments that belong here; maintainers get a collapsed "Other branches & builds" group so nothing is lost; on a non-main branch the drawer footer has "Include comments from main" (per browser), to turn off for a branch that is a separate site. `MAIN_BRANCH` in the environment overrides the default "main".

### Simple and advanced mode

The drawer header has an **Advanced** switch, remembered per browser (`localStorage`). The toolbar is the same in both modes: one "Select element" control (its arrow opens a menu with Select element, Rectangle, Circle and Draw), the View control, Hold hover, Comments and Exit. Simple mode (the default) is for commenters: a comment shows its screenshot, section and element text; the composer is a screenshot plus a text box. The inferred scope, category and sizes still apply underneath. Each comment and the composer keep a **Details** link that reveals the hidden parts for that one item. Advanced mode shows everything: selectors, style rules, held state, the breadcrumb, "Applies to", "About", "Sizes" and "Check on" controls.

### Inspect tool, scopes and categories

**Select element** (the default tool, called Inspect internally) anchors a comment to an exact element: hover outlines the element under the pointer with a `tag.class  W×H` badge (like DevTools), ↑ / ↓ walk to the parent or first child, click picks it. The comment is then anchored to that element (`type: element`), so the mark is the element's live box and survives reflow exactly. The composer shows the ancestry as a breadcrumb; clicking a crumb widens or narrows the selection. Rectangle, circle and draw remain for "roughly here"; a click without a drag with those tools leaves a pin.

Every comment carries a **scope** and a **category**:

| scope | Meaning | Listed where |
|---|---|---|
| `page` | About this page only | That page |
| `component` | About a shared block that appears on every page | Every page, under "Shared components & site-wide"; the marker shows wherever the block's selector resolves |
| `site` | About a site-wide rule (a heading size, a button colour) | Every page |

Scope is inferred from the picked element: inside a block marked `data-component="…"` (this site tags `site-header`, `primary-nav`, `header-actions`, `mobile-menu`, `utility-bar`, `site-footer`, `prototype-note`; other sites fall back to `header`, `nav`, `footer` landmarks) means `component`; otherwise `page`. The reviewer can override it in the composer ("Applies to"). Category (content, navigation, layout, typography, colour, imagery, other) is guessed from the element and can also be changed.

For headings, links, buttons and paragraphs the target also records the computed font, size, weight and colour, and the stylesheet rules that set them (`target.style`), with how many elements on the page each rule affects. A comment such as "the H1 is too big" therefore points at `.page-hero h1` in `styles.css`, not only at one heading. If an open comment already exists on the same element or the same rule, the composer says so and offers "Reply there instead".

The practical effect: before anyone (human or agent) rewrites the header, footer or a global style, the open comments about it are visible on every page and queryable by `scope` and `component` in the database.

### Screen sizes and device frames

Marks are stored against an element, so they re-anchor at any width, but layouts change across breakpoints (the desktop nav is hidden on phones; grids collapse), and pins or drawn shapes are only approximate once an element's inner layout reflows. The overlay therefore treats size as a first-class condition:

- **Recorded on every comment:** viewport width and height, pixel ratio, the breakpoint name (`phone`, `tablet`, `desktop`), the device frame used if any, user agent and touch capability (`viewport`). Cards show "desktop 1447" style metadata.
- **Desktop by default.** When Review Mode starts in a window that is in the desktop layout (wider than the largest breakpoint), it opens the Desktop 1280 frame after sign-in, so every reviewer sees the same width. Choosing "Actual window" or "Exit frame" is remembered for the browser session; exiting Review Mode forgets it. Phones and tablets start in their actual window.
- **Device frames.** The toolbar's View control (Actual window · Phone 390 · Tablet 820 · Desktop 1280) renders the page inside an iframe of that exact CSS width (scaled down to fit the window if needed), so media queries behave as on that device. The URL carries `?tmView=phone|tablet|desktop|<px>`, so a frame is shareable. Inside a frame the View control resizes live without reloading, so a draft survives switching sizes. The review toolbar, drawer, toasts and dialogs are mounted in the shell (the top document) over the frame, at full size, while markers and drawing stay inside the frame; opening the drawer shifts the frame left. The URL bar of the frame is the page's own, so links inside it navigate the frame and the shell re-mounts the review UI for the new page. Breakpoints are read from the site's stylesheet (`max-width` media queries, here 650 and 1000 px); `window.TexoModoConfig.breakpoints` overrides them. Google sign-in cannot run inside an iframe, so sign in at top level first.
- **"Sizes" on every comment** (`devices`): checkboxes Phone / Tablet / Desktop, defaulting to the sizes where the element is visible according to the stylesheet (`target.visibleAt`; for example the desktop nav defaults to desktop only, the mobile menu to phone and tablet). Empty means all sizes. The author can edit it later from the card.
- **Snap to the comment's conditions.** A comment made at a different breakpoint shows "View at phone 390", which opens a frame at the recorded width and focuses the comment. Each card and the composer also have "Check on: Phone · Tablet · Desktop" to look at the same spot at other sizes; outside a frame this opens the frame shell and restores the draft afterwards.
- **Markers respect sizes.** A desktop-only comment on a phone frame is listed with a struck-through "desktop only" chip and no marker.

Inside a frame the overlay switches the page to instant scrolling (the site's `scroll-behavior: smooth` stalls in a scaled iframe in Chrome) and handles fragment links (`about.html#councils`) itself, because the browser would otherwise scroll the shell's clipped wrapper and cut off the top of the page.

Limits: a frame reproduces width and breakpoints exactly, not a phone's fonts, zoom or touch behaviour; `visibleAt` is an order-based reading of the stylesheet (specificity ignored) and is corrected by the live DOM for the current size.

### Hover-only UI (dropdown menus, tooltips)

While a tool is active the annotation layer takes the pointer, so anything that only appears on hover would close. Hover the element first, then press **H** (or the "Hold hover" toolbar button). The overlay clones every same-origin CSS rule that uses `:hover` into an equivalent `[data-tm-hold]` rule and marks the hovered chain of elements, so the menu stays open with the pointer anywhere. Pick a tool and mark it. The held selectors are stored on the annotation (`target.state.held`), the screenshot shows the open state, and selecting the comment later re-applies the state so the marker makes sense; markers on hidden anchors render as dashed "ghosts" until selected. Press H again (or exit) to release.

### Deep links

`page.html?review=<annotation-id>` opens Review Mode (after sign-in), opens the drawer and scrolls to the annotation. "Copy link" on a comment produces this URL. Exit removes the parameter. Normal URLs are untouched.

### Modes

`config.json.mode` is one of:
- `supabase`: production. Requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- `local`: UI development only. `REVIEW_LOCAL_MODE=true` and no Supabase URL. Comments stay in the browser's localStorage, the author is "Local reviewer", and the drawer says so in red.
- `disabled`: nothing configured. The button shows a short error and goes away.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | Netlify + local `.env` | Project URL (public) |
| `SUPABASE_ANON_KEY` | Netlify + local `.env` | The **publishable** key (`sb_publishable_…`, "anon" on the Legacy tab). Public; RLS protects data. The build refuses a secret key here. |
| `TEXOMODO_SITE_ID` | Netlify + local `.env` | Which website this deploy is inside the Supabase project, e.g. `allsaints`. Lowercase slug; must exist in `sites` (`npm run allowlist` creates it). Required with Supabase. |
| `TEXOMODO_SITE_NAME` | Netlify + local `.env` | Display name for messages. Also sets `sites.name` when the allowlist is synced. |
| `ALLOWED_GOOGLE_DOMAIN` | local `.env` (and Netlify for the hint) | Google Workspace domain whose accounts may review, e.g. `asccnc.org`. Enforced via the `review_access` table, not at build time. |
| `ALLOWED_EMAILS` | local `.env` | Comma-separated individual accounts (personal Gmail reviewers). |
| `ALLOWED_MAINTAINERS` | local `.env` | Comma-separated emails with the maintainer role on this site (verify, resolve, edit anyone's comments). |
| `PLATFORM_ADMINS` | local `.env`, optional | Comma-separated emails that are maintainers on **every** site of the project. Empty leaves existing platform rows untouched. |
| `SUPABASE_SERVICE_ROLE_KEY` | local `.env` only | The **secret** key (`sb_secret_…`, "service_role" on the Legacy tab). Used by `npm run allowlist`. **Never on Netlify, never in the browser.** The build fails if it detects this key in a Netlify environment. |
| `REVIEW_LOCAL_MODE` | local `.env` | `true` to run without a backend. |
| `REVIEW_AI_CHANGES` | Netlify, optional | `true` shows the "Ask AI to change this" button on comment cards. Off by default until the Phase 2 pipeline exists. |

Netlify-provided variables used for build metadata: `COMMIT_REF`, `BRANCH`, `CONTEXT`, `DEPLOY_PRIME_URL`, `DEPLOY_URL`, `URL`, `DEPLOY_ID`, `REVIEW_ID`.

## Local setup

```bash
cp .env.example .env          # fill in SUPABASE_URL / SUPABASE_ANON_KEY, or REVIEW_LOCAL_MODE=true
npm run dev                   # builds site/review/, serves site/ at http://localhost:8080
npm run check                 # repository checks
```

No npm dependencies. Node 18+.

For Google sign-in on localhost, add `http://localhost:8080/**` to the Supabase redirect allowlist (below).

## Supabase setup

1. Create a project. Note the Project URL and the publishable key (Project Settings → API Keys). Copy the secret key only into your local `.env`.
2. SQL editor → run `supabase/migrations/0001_review_schema.sql`, then 0002 to 0006 in order. This creates the tables, functions, policies, the `review-screenshots` bucket and the realtime publication. It is safe to re-run. (0006 backfills existing rows to the site id `allsaints`; edit that line first if yours differs.)
3. Authentication → URL configuration: set the Site URL to the Netlify production URL, and add redirect URLs for every place reviewers will sign in:
   - `https://<site>.netlify.app/**`
   - `https://deploy-preview-*--<site>.netlify.app/**` (Deploy Previews, needed for Phase 2)
   - `http://localhost:8080/**`
4. Allowlist: put `TEXOMODO_SITE_ID`, `TEXOMODO_SITE_NAME`, `ALLOWED_GOOGLE_DOMAIN` / `ALLOWED_EMAILS` / `ALLOWED_MAINTAINERS` and the service role key in `.env`, then `npm run allowlist` (it also creates the `sites` row). (Or `npm run allowlist -- --print` and paste the SQL into the editor if you prefer not to keep the service key locally.)
5. Optional hardening: Authentication → Providers → Google → restrict to your Workspace domain as well. The database check still applies to personal accounts on the list.

## Google OAuth setup

In Google Cloud Console (the parish's Workspace organisation, or any Google account that owns the project):

1. APIs & Services → OAuth consent screen. User type: **External** if personal Gmail reviewers are on the allowlist (Internal would block them). Add the app name and support email. Scopes: email, profile, openid.
2. Credentials → Create credentials → OAuth client ID → Web application.
   - Authorised JavaScript origins: `https://<project-ref>.supabase.co`
   - Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
3. Copy the Client ID and Client Secret into Supabase → Authentication → Providers → Google, and enable it.
4. While the consent screen is in "Testing" status, add each reviewer as a test user, or publish the app.

The overlay requests `prompt=select_account` so reviewers with several Google accounts can pick the right one.

## Netlify configuration

1. Site configuration → Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEXOMODO_SITE_ID`, `TEXOMODO_SITE_NAME`, `ALLOWED_GOOGLE_DOMAIN` (hint only). Do **not** add the service role key.
2. Build settings come from `netlify.toml` (command `node `texomodo build``, publish `site`). Make sure the UI doesn't override them.
3. Deploy. Visit any page, click "Comment / Review", sign in.
4. For Deploy Previews to support sign-in, the redirect allowlist in Supabase must include the preview pattern (above).

## Security summary

- Review access is enforced by RLS on every table and on Storage objects, per site; the toolbar is cosmetic.
- The browser holds only the anon key. Service role key: local scripts and (later) server-side functions only.
- Comments and replies are plain text, rendered as text. No HTML from users is ever inserted.
- Reviewers can resolve/reopen anyone's comment and delete only their own (database trigger + policies).
- `change_requests` is insert-only from the browser. Only server-side code can advance a request.
- No GitHub token exists anywhere in this phase.

## Accessibility notes

Toolbar buttons are real buttons with `aria-pressed`; the drawer is a non-modal dialog, so the page stays scrollable and usable; Esc cancels the current tool, the draft, or closes the drawer; focus moves into the composer when a mark is placed and returns to the toolbar when the drawer closes; markers are buttons with descriptive labels; open/resolved are distinguished by shape and label, not colour alone; the drawer becomes a bottom sheet under 650 px with the toolbar still visible.

## Known limitations

- Screenshots depend on html2canvas (loaded from a CDN on first use); cross-origin images such as the logo render blank. The capture is best-effort and never blocks posting.
- Anchors are CSS paths; if a page is restructured, an old annotation falls back to its absolute position and is marked as such in the data (`anchored: false` at render time). Component and site-wide comments made on another page are listed but get no marker when their selector doesn't resolve on the current page.
- Style rules are read from same-origin stylesheets only; the "affects" count is per page, not per site.
- Realtime requires the tables in the `supabase_realtime` publication (the migration does this). Without it, the Refresh button still works.
