/**
 * POST /.netlify/functions/change-request        (Phase 2 extension point)
 *
 * Turns an annotation into an AI change request. NOT IMPLEMENTED YET: this
 * stub documents the contract and returns 501 so the browser button can be
 * wired to it later without changing the client.
 *
 * Request  (JSON, Authorization: Bearer <Supabase access token>)
 *   { "annotationId": "<uuid>", "instruction": "<what to change>" }
 *
 * Planned behaviour (all server-side, narrowly scoped credentials):
 *   1. Verify the Supabase JWT with the anon key (auth.getUser) and call
 *      review_is_authorized() so only allowlisted reviewers can request work.
 *   2. Read the annotation (service role) and snapshot it into
 *      change_requests.page_context; insert the row with status "requested".
 *   3. Hand the ChangeRequest (review/types.d.ts) to a coding agent that reads
 *      AGENTS.md, docs/ and data/, works on a NEW branch, edits only the files
 *      the request needs, runs `npm run check`, pushes, opens a GitHub PR.
 *      Netlify builds a Deploy Preview for the PR.
 *   4. Update the row: branch, pull_request_url, preview_url, status
 *      "preview-ready"; the annotation thread shows View Preview / View PR /
 *      Approve / Reject. Approve = a human merges the PR. The agent never
 *      pushes to main.
 *
 * Environment (Netlify, server-side only): SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY (functions only, never the build), GITHUB_TOKEN
 * scoped to this repo (contents + pull_requests), and the agent credentials.
 */
export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  return json({
    error: 'Not implemented',
    detail: 'AI change requests are a Phase 2 feature. See docs/ai-change-requests.md.',
  }, 501);
}

export const config = { path: '/.netlify/functions/change-request' };

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
