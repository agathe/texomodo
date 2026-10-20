/**
 * Review Mode data contracts.
 *
 * These types are documentation for humans and coding agents. The browser code
 * (review/review.js) is plain JavaScript that produces objects of exactly this
 * shape, and supabase/migrations/0001_review_schema.sql stores them (JSON
 * columns hold the nested objects). Keep all three in sync.
 */

/** Where the annotation sits on the page. Coordinates are fractions (0..1) of
 *  the anchor element's box so they survive responsive reflow; `absolute` is
 *  the document-pixel fallback captured at creation. */
export type AnnotationGeometry =
  | { kind: 'pin'; selector: string; x: number; y: number; absolute: DocRect }
  /** Inspect tool: the comment is about this element; its live box is the mark. */
  | { kind: 'element'; selector: string; absolute: DocRect }
  | { kind: 'rectangle' | 'circle'; selector: string; x: number; y: number; w: number; h: number; absolute: DocRect }
  | { kind: 'draw'; selector: string; points: Array<[number, number]>; absolute: DocRect };

/** Document-pixel rectangle (page coordinates, not viewport). */
export interface DocRect { x: number; y: number; w: number; h: number }

/** The DOM element the reviewer pointed at, captured for humans and agents.
 *  Strings are length-capped (see review.js LIMITS) to avoid DOM dumps. */
export interface AnnotationTarget {
  /** Stable-ish CSS selector, unique on the page at capture time. */
  selector: string;
  tagName: string;
  id: string | null;
  classes: string[];
  /** Landmark ancestor: header, nav, main, footer, aside or null. */
  landmark: string | null;
  /** Nearest preceding heading text, e.g. "Weekend Mass". */
  heading: string | null;
  /** Readable path such as "main > section.cream > div.card > div.mass-row". */
  path: string;
  /** Visible text of the element (capped). */
  text: string;
  /** Text of the surrounding block for context (capped). */
  nearbyText: string;
  /** Text the reviewer had selected, if any. */
  selectedText: string | null;
  /** outerHTML of the element (capped) so an agent can locate it in source. */
  html: string;
  /** Viewport-relative bounding rect at capture time. */
  boundingRect: { x: number; y: number; width: number; height: number };
  /** Whether the element was visible (not opacity 0 / visibility hidden) at capture time. */
  visible: boolean;
  /** Hover/open state the reviewer held while marking (selectors of the elements
   *  that had :hover applied, e.g. an open dropdown). Selecting the comment re-applies it. */
  state: { held: string[] } | null;
  /** Which breakpoints show this element (phone/tablet/desktop), inferred from the
   *  stylesheet's display rules; the current breakpoint uses the live DOM. */
  visibleAt: Record<string, boolean>;
  /** Computed typography/colour and the same-origin stylesheet rules that match
   *  the element and set layout/typography properties (last = most specific). */
  style: {
    computed: { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; color: string; backgroundColor: string };
    rules: Array<{ selector: string; properties: string[]; css: string; sheet: string; media: string | null; active: boolean; affectsOnPage: number }>;
  } | null;
}

/** page: this page only. component: a shared block (header, footer, nav) that
 *  appears on every page; listed everywhere and anchored wherever its selector
 *  resolves. site: a site-wide rule (typography, colour); listed everywhere. */
export type AnnotationScope = 'page' | 'component' | 'site';
export type AnnotationCategory = 'content' | 'navigation' | 'layout' | 'typography' | 'color' | 'imagery' | 'other';

export interface ReviewUser {
  email: string;
  name: string;
  avatar?: string | null;
}

/** site/review/config.json, written by scripts/build.mjs. Public values only. */
export interface ReviewConfig {
  mode: 'supabase' | 'local' | 'disabled';
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** SITE_ID: which site in the Supabase project this deploy is ("local" in local mode). */
  site: string;
  /** SITE_NAME, for messages ("not authorized to review All Saints"). */
  siteName: string | null;
  allowedDomainHint: string | null;
  /** REVIEW_AI_CHANGES=true: show the "Ask AI to change this" button (Phase 2). Default off. */
  aiChangeRequests: boolean;
  build: BuildInfo;
}

export interface BuildInfo {
  commit: string | null;
  branch: string | null;
  /** Netlify context: production | deploy-preview | branch-deploy | local */
  context: string;
  deployUrl: string | null;
  deployId: string | null;
  reviewId: string | null;
  builtAt: string;
  /** Name of the production branch (MAIN_BRANCH env, default "main"). */
  mainBranch?: string;
  /** Short SHAs of the commits this deployment contains, newest first (up to 400).
   *  A comment belongs on a deployment when its build.commit is in this list. */
  ancestors?: string[];
  /** True when the build's git clone was shallow, so `ancestors` may be incomplete. */
  shallow?: boolean;
}

export type AnnotationType = 'pin' | 'element' | 'rectangle' | 'circle' | 'draw';
/** open -> verified (a maintainer confirmed target, scope and sizes) -> resolved.
 *  Reopen is always possible. Reviewers may resolve their own comments. */
export type AnnotationStatus = 'open' | 'verified' | 'resolved';
export type AnnotationResolution = 'addressed' | 'declined';
/** reviewer: edits own comments/replies, resolves own comments.
 *  maintainer: edits anyone's metadata and text, verifies, resolves, reopens, deletes. */
export type ReviewRole = 'reviewer' | 'maintainer';

/** One row of the database-written activity log (annotation_events). */
export interface AnnotationEvent {
  id: number | string;
  actor: ReviewUser;
  kind: 'created' | 'edited' | 'moved' | 'metadata' | 'verified' | 'resolved' | 'reopened' | 'replied' | 'reply_edited' | 'reply_deleted';
  /** { field: { from, to } } for edits and metadata; { resolution } for resolved; { replyId } for replies. */
  changes: Record<string, unknown> | null;
  at: string;
}

export interface Annotation {
  id: string;
  /** The reviewed website this comment belongs to (sites.id = SITE_ID of the deploy).
   *  One Supabase project can hold several sites, each with its own allowlist. */
  site: string | null;
  /** Pathname, e.g. "/mass-times.html". Comments are grouped by this. */
  page: string;
  url: string;
  title: string | null;
  type: AnnotationType;
  geometry: AnnotationGeometry;
  /** The conditions the comment was made under. breakpoint names come from the
   *  site's stylesheet (max-width media queries): phone | tablet | desktop.
   *  preset is the device frame used ('phone', 'tablet', 'desktop' or a pixel
   *  width as a string), or null for the reviewer's actual window. */
  viewport: { width: number; height: number; dpr: number; breakpoint: string; preset: string | null; userAgent: string; touch: boolean };
  scroll: { x: number; y: number };
  target: AnnotationTarget | null;
  scope: AnnotationScope;
  /** Shared block name when scope = component, e.g. "site-header" (from data-component or the landmark tag). */
  component: string | null;
  category: AnnotationCategory | null;
  /** Breakpoint names the comment applies to. Empty = all sizes. Defaults to the
   *  sizes where the target element is visible (target.visibleAt). */
  devices: string[];
  comment: string;
  author: ReviewUser;
  authorId: string;
  status: AnnotationStatus;
  resolution: AnnotationResolution | null;
  resolvedAt: string | null;
  resolvedBy: ReviewUser | null;
  verifiedAt: string | null;
  verifiedBy: ReviewUser | null;
  editedAt: string | null;
  editedBy: ReviewUser | null;
  /** Activity log, oldest first. Written by database triggers only. */
  events: AnnotationEvent[];
  build: BuildInfo | null;
  /** Object path in the private review-screenshots bucket, or null. */
  screenshotPath: string | null;
  createdAt: string;
  updatedAt: string;
  replies: Reply[];
}

export interface Reply {
  id: string;
  annotationId: string;
  author: ReviewUser;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

/* -------------------------------------------------------------------------
 * Phase 2: annotation -> AI change request -> GitHub PR -> Netlify preview
 * Stored in change_requests. Reviewers may create one; only server-side code
 * (netlify/functions/change-request.mjs and the agent runner) may advance it.
 * ---------------------------------------------------------------------- */

export type ChangeRequestStatus =
  | 'requested'
  | 'working'
  | 'preview-ready'
  | 'approved'
  | 'rejected'
  | 'failed';

export interface ChangeRequest {
  id: string;
  annotationId: string;
  /** What the reviewer asked for, in their words. */
  instruction: string;
  status: ChangeRequestStatus;
  requestedBy: ReviewUser;
  /** Snapshot of the annotation at request time (page, target, geometry, build, comment, replies). */
  pageContext: Pick<Annotation, 'page' | 'url' | 'title' | 'target' | 'geometry' | 'build' | 'comment' | 'replies'> | null;
  /** Filled by the pipeline: where the agent worked. */
  repositoryContext: {
    repo: string;
    baseBranch: string;
    baseCommit: string;
    /** Files the agent touched; kept narrow by AGENTS.md rules. */
    files: string[];
  } | null;
  branch: string | null;
  pullRequestUrl: string | null;
  previewUrl: string | null;
  log: Array<{ at: string; event: string; detail?: string }>;
  createdAt: string;
  updatedAt: string;
}

/** Storage adapter implemented by review.js for Supabase and (dev only) localStorage. */
export interface ReviewStore {
  listForPage(page: string): Promise<Annotation[]>;
  /** Every comment of the site; the drawer derives the page list from it and shows the rest under "All pages". */
  listAll(): Promise<Annotation[]>;
  create(input: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'replies' | 'authorId'>): Promise<Annotation>;
  reply(annotationId: string, body: string): Promise<Reply>;
  setStatus(annotationId: string, status: AnnotationStatus, resolution?: AnnotationResolution): Promise<void>;
  /** Field edits by the author or a maintainer; re-anchoring passes type + geometry + target. */
  update(annotationId: string, patch: Partial<Pick<Annotation, 'comment' | 'devices' | 'scope' | 'component' | 'category' | 'type' | 'geometry' | 'target'>>): Promise<void>;
  updateReply(replyId: string, body: string): Promise<void>;
  removeReply(replyId: string): Promise<void>;
  role(): Promise<ReviewRole>;
  remove(annotationId: string): Promise<void>;
  uploadScreenshot(annotation: Annotation, blob: Blob, dataUrl?: string): Promise<string | null>;
  screenshotUrl(path: string): Promise<string | null>;
  requestChange(annotationId: string, instruction: string): Promise<ChangeRequest>;
  subscribe(page: string, onChange: () => void): () => void;
}
