# AI change requests (Phase 2 design)

Not built yet. This documents the boundary that Phase 1 already respects so Phase 2 can be added without changing the annotation model or the client.

## Pipeline

```
annotation (review thread)
  ↓  reviewer clicks "Ask AI to change this" and writes an instruction
change_requests row  status: requested          ← inserted by the client (RLS: insert-only)
  ↓  POST /.netlify/functions/change-request    ← verifies the Supabase JWT + allowlist
agent runner (server-side, service role, scoped GitHub token)
  ↓  reads: the ChangeRequest, AGENTS.md, docs/, data/, the page's source
  ↓  status: working
  ↓  git checkout -b review/<short-annotation-id>-<slug>
  ↓  edits only the files the request needs; runs `npm run check`
  ↓  pushes the branch; opens a GitHub PR (body links the annotation deep link)
Netlify Deploy Preview builds automatically for the PR
  ↓  status: preview-ready, branch, pull_request_url, preview_url
annotation thread shows: "Proposed change ready" [View Preview] [View Diff / PR] [Approve] [Reject]
  ↓  Approve → a human merges the PR (status: approved); Reject → PR closed (status: rejected)
```

The agent never pushes to `main` (DD-010). "Approve" records intent; merging is a human action in GitHub, or, later, a server-side merge that still requires a reviewer with write access.

## Data already in place

- `change_requests` table with the status enum `requested | working | preview-ready | approved | rejected | failed`, `instruction`, `requested_by`, `page_context`, `repository_context`, `branch`, `pull_request_url`, `preview_url`, `log` (`supabase/migrations/0001_review_schema.sql`).
- `ChangeRequest` interface in `overlay/types.d.ts`.
- `ReviewStore.requestChange(annotationId, instruction)` and `window.TexoModo.requestChange(...)` in `overlay/review.js`: writes the row with a snapshot of the annotation (page, target, geometry, build, comment, replies) as `page_context`.
- Every annotation carries `build.commit` so the agent can check out exactly the version the reviewer saw, and `target.selector` / `target.html` so it can find the element in source.
- A disabled "Ask AI to change this" button in each thread, and a stub `netlify/functions/change-request.mjs` returning 501.

## Turning the button on

The comment card's "Ask AI to change this" button is hidden by default. Set `REVIEW_AI_CHANGES=true` in the deploy's environment once the pipeline below exists; the button, the `requestChange` store method and the `change_requests` table are already wired.

## Sites

The Supabase project may hold several websites (migration 0006). A change request belongs to the site of its annotation (`review_annotation_site(annotation_id)`); the runner must map that site id to a repository and never act on a request whose site does not match the repo it was started for.

## What Phase 2 adds

0. **Gate:** only `verified` comments may become change requests (the `change_requests` insert policy checks the annotation's status). Verification is the human triage step: a maintainer has confirmed the target, scope and sizes.
1. **The function:** validate the bearer token with `supabase.auth.getUser`, call `review_is_authorized()`, insert/advance the `change_requests` row with the service role, enqueue the job (Netlify Background Function, a GitHub Actions `workflow_dispatch`, or a small worker).
2. **The agent run:** a coding agent (for example Claude Code in headless mode) started with the repository checked out at `build.commit`, the `ChangeRequest` JSON, and the instruction to read `AGENTS.md` first. Narrow scope: the page named in the annotation plus `assets/styles.css` if needed. Must run `npm run check` before pushing.
3. **GitHub integration:** a fine-grained token limited to this repository with `contents: write` and `pull_requests: write`. Stored only in Netlify's function environment (or the worker's secrets). Branch protection on `main` requiring a PR and a review.
4. **Netlify:** Deploy Previews already build per PR. Add the preview URL pattern to the Supabase redirect allowlist so reviewers can sign in on a preview and see the same threads (annotations are keyed by page path, not by host).
5. **Client:** enable the button; show the request's status in the thread; add View Preview / View PR / Approve / Reject; subscribe to `change_requests` changes.
6. **Status writes:** the runner posts progress to `change_requests.log` so the thread can show "working…".

## `@ai` questions in threads

Later, a reply starting with `@ai` can be answered by an agent that has only the repository as context (no RAG): it reads `AGENTS.md`, `docs/information-architecture.md`, `docs/design-decisions.md`, `docs/analytics.md`, the relevant `data/` files and the page source, then posts a reply as a reserved "AI" author. Examples it should be able to answer from the docs alone:

- "Why is Bulletin in the utility navigation?" → DD-002, `information-architecture.md` (utility = frequent tasks).
- "Would moving Livestream under Faith be better?" → DD-002 rationale, livestream traffic in `analytics.md`, the layer model.

This works only if the docs stay current, which is why `design-decisions.md` exists and why AGENTS.md tells agents to record decisions there.

## Guardrails for the runner

- Operate on a branch; never force-push; never touch `main`.
- Touch only the files the request needs. If the change needs an IA or content-rule change, stop and reply in the thread instead of silently changing structure.
- Don't change facts (times, addresses) unless `data/parish-facts.json` confirms them.
- Don't commit anything from `.env`, `review/config.json`, or donor/contact data.
- Run `npm run check`; fail the request (status `failed`, log the reason) rather than opening a broken PR.
