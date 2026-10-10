-- Code Suggest (spec 14 §6.4): a suggestion is a Cloud Patch (kind 'suggestion') plus PR coordinates.
-- Rows disappear with their patch (purge job / account deletion) or their author.
create table suggestions (
  id uuid primary key,
  patch_id text not null references patches (id) on delete cascade,
  author_id uuid not null references users (id) on delete cascade,
  provider text not null,
  host text not null,
  owner text not null,
  repo text not null,
  pr_number integer not null check (pr_number > 0),
  pr_head_sha text not null,
  title text not null,
  status text not null default 'open' check (status in ('open', 'applied', 'dismissed')),
  status_by uuid references users (id) on delete set null,
  comment_id text,
  co_author jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index suggestions_pr on suggestions (provider, lower(owner), lower(repo), pr_number, created_at desc);
create unique index suggestions_patch on suggestions (patch_id);
