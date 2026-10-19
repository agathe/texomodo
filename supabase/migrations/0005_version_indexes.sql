-- ============================================================================
-- 0005: indexes for version-aware views
--
-- Comments already record the deployment they were made on in the `build`
-- JSON column ({ commit, branch, context, deployUrl, deployId, ... }). The
-- overlay decides visibility per deployment (see docs/review-system.md,
-- "Versions"); these indexes make the maintainer views and future reports
-- by branch or commit cheap. No data changes.
-- ============================================================================

create index if not exists annotations_build_branch_idx on public.annotations ((build ->> 'branch'));
create index if not exists annotations_build_commit_idx on public.annotations ((left(build ->> 'commit', 7)));
