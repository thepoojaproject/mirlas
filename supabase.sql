-- ============================================================================
-- LiveChat — Supabase SQL Schema
--
-- Run this entire file once in: Supabase Dashboard → SQL Editor → New query.
-- It is safe to re-run (uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS
-- guards) while you're setting the project up.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

-- One row per authenticated user. id mirrors auth.users.id so profiles are
-- deleted automatically if the underlying auth user is ever removed.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 100),
  email       text not null,
  avatar      text,
  online      boolean not null default false,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'Public profile + presence info for each LiveChat user.';

-- One row per 1-to-1 chat message. Messages are immutable (no update/delete
-- policies are granted — see section 3).
create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  receiver_id  uuid not null references public.profiles(id) on delete cascade,
  content      text not null check (char_length(content) between 1 and 2000),
  created_at   timestamptz not null default now(),
  constraint messages_no_self_send check (sender_id <> receiver_id)
);

comment on table public.messages is '1-to-1 chat messages between two profiles.';

-- ----------------------------------------------------------------------------
-- 2. INDEXES
-- ----------------------------------------------------------------------------

-- Case-insensitive name search + default directory ordering.
create index if not exists idx_profiles_name_lower on public.profiles (lower(name));

-- Fast lookup of a conversation between two specific users, newest last.
create index if not exists idx_messages_conversation
  on public.messages (least(sender_id, receiver_id), greatest(sender_id, receiver_id), created_at);

-- Fast lookup of "all messages sent/received by user X".
create index if not exists idx_messages_sender on public.messages (sender_id);
create index if not exists idx_messages_receiver on public.messages (receiver_id);

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.messages enable row level security;

-- ---- profiles -----------------------------------------------------------

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true); -- any signed-in user can see the directory (needed for the sidebar/search)

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No delete policy is defined, so profile rows can never be deleted via the
-- client (they are only removed automatically via the auth.users cascade).

-- ---- messages -------------------------------------------------------------

drop policy if exists "messages_select_participant" on public.messages;
create policy "messages_select_participant"
  on public.messages for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

drop policy if exists "messages_insert_as_self" on public.messages;
create policy "messages_insert_as_self"
  on public.messages for insert
  to authenticated
  with check (auth.uid() = sender_id);

-- No update/delete policies are defined — messages are immutable once sent.

-- ----------------------------------------------------------------------------
-- 4. AUTO-CREATE PROFILE ON SIGNUP
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, online, last_seen)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    false,
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 5. REALTIME
-- Ensures INSERT/UPDATE/DELETE events on these tables are broadcast to
-- subscribed clients (filtered per-client by the RLS policies above).
-- ----------------------------------------------------------------------------

alter table public.profiles replica identity full;
alter table public.messages replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. OPTIONAL — AVATAR STORAGE
-- The `profiles.avatar` column stores a public URL. If you later add avatar
-- upload support, create a public "avatars" bucket (Storage → New bucket)
-- and apply policies like the ones below.
-- ----------------------------------------------------------------------------

-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
--   on conflict (id) do nothing;
--
-- create policy "avatar_public_read"
--   on storage.objects for select
--   to public
--   using (bucket_id = 'avatars');
--
-- create policy "avatar_owner_write"
--   on storage.objects for insert
--   to authenticated
--   with check (bucket_id = 'avatars' and owner = auth.uid());
--
-- create policy "avatar_owner_update"
--   on storage.objects for update
--   to authenticated
--   using (bucket_id = 'avatars' and owner = auth.uid());
