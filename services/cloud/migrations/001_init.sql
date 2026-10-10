-- Prototype A Cloud initial schema (spec 14 §5.2). Applied once, in order, by src/store/migrate.ts.
-- Emails are stored lower-cased in plain text (no citext extension needed).

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  avatar_url text,
  created_at timestamptz not null,
  deleted_at timestamptz
);
create index users_deleted_at on users (deleted_at) where deleted_at is not null;

create table identities (
  provider text not null,
  host text not null,
  subject text not null,
  user_id uuid not null references users (id) on delete cascade,
  primary key (provider, host, subject)
);
create index identities_user on identities (user_id);

create table auth_codes (
  hash bytea primary key,
  user_id uuid not null references users (id) on delete cascade,
  code_challenge text not null,
  redirect_uri text not null,
  expires_at timestamptz not null
);

create table used_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);

create table refresh_tokens (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  family_id uuid not null,
  hash bytea not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create index refresh_tokens_family on refresh_tokens (family_id);
create index refresh_tokens_user on refresh_tokens (user_id);

create table orgs (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  policies jsonb not null,
  footprint_salt text not null,
  created_by uuid not null,
  created_at timestamptz not null
);

create table org_members (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null,
  primary key (org_id, user_id)
);
create index org_members_user on org_members (user_id);

create table teams (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null,
  created_at timestamptz not null
);
create index teams_org on teams (org_id);

create table team_members (
  team_id uuid not null references teams (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (team_id, user_id)
);
create index team_members_user on team_members (user_id);

create table invites (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  token_hash bytea not null unique,
  created_by uuid not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  accepted_at timestamptz
);
create index invites_org on invites (org_id);

-- Settings sync: opaque ciphertext only (spec 14 §6.2).
create table sync_items (
  user_id uuid not null references users (id) on delete cascade,
  category text not null,
  version bigint not null,
  ciphertext bytea not null,
  nonce bytea not null,
  device_id text,
  updated_at timestamptz not null,
  primary key (user_id, category)
);

create table workspaces (
  id uuid primary key,
  owner_user_id uuid not null references users (id) on delete cascade,
  org_id uuid references orgs (id) on delete cascade,
  version bigint not null,
  doc jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index workspaces_owner on workspaces (owner_user_id);

create table workspace_shares (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  principal_type text not null check (principal_type in ('team', 'user', 'org')),
  principal_id uuid not null,
  primary key (workspace_id, principal_type, principal_id)
);
create index workspace_shares_principal on workspace_shares (principal_type, principal_id);

create table launchpad_state (
  user_id uuid primary key references users (id) on delete cascade,
  version bigint not null,
  doc jsonb not null,
  updated_at timestamptz not null
);

-- Repo identities are scoped per org (footprints); patches carry their repo inline.
create table repo_identities (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  key text not null,
  provider text not null,
  host text not null,
  owner text not null,
  name text not null,
  initial_commit_sha text,
  created_at timestamptz not null,
  unique (org_id, key)
);

create table patches (
  id text primary key,
  author_id uuid not null references users (id) on delete cascade,
  org_id uuid references orgs (id) on delete set null,
  repo jsonb,
  repo_key text,
  title text not null,
  description text,
  kind text not null check (kind in ('wip', 'commit', 'stash', 'suggestion')),
  base_sha text not null,
  base_branch text,
  files jsonb,
  e2e boolean not null,
  size bigint not null,
  sha256 text not null,
  visibility text not null check (visibility in ('link', 'org', 'collaborators')),
  status text not null check (status in ('pending', 'complete')),
  created_at timestamptz not null,
  completed_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz
);
create index patches_author on patches (author_id, created_at desc, id desc);
create index patches_org on patches (org_id, created_at desc, id desc) where org_id is not null;
create index patches_expires on patches (expires_at) where expires_at is not null;

create table patch_collaborators (
  patch_id text not null references patches (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (patch_id, user_id)
);
create index patch_collaborators_user on patch_collaborators (user_id);

-- Team footprints: hashes + line ranges, never file contents (spec 14 §6.5). TTL 14 days.
create table footprints (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  repo_identity_id uuid not null references repo_identities (id) on delete cascade,
  branch_hash text not null,
  branch_label text,
  base_ref text not null,
  head_sha text not null,
  files jsonb not null,
  updated_at timestamptz not null,
  primary key (org_id, user_id, repo_identity_id, branch_hash)
);
create index footprints_repo on footprints (org_id, repo_identity_id, updated_at);
create index footprints_updated on footprints (updated_at);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null,
  actor_id uuid not null,
  org_id uuid,
  action text not null,
  target text not null,
  detail jsonb
);
create index audit_log_org on audit_log (org_id, at);
