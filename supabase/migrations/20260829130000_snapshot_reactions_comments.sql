-- Reazioni e commenti sulle istantanee (righe smokes con photo_path).
-- RLS restrittivo: ogni utente vede/scrive solo le proprie righe. La lettura
-- delle reazioni/commenti altrui passa dalle RPC SECURITY DEFINER (get_snapshot_feed,
-- get_snapshot_comments) che filtrano con can_see_snapshot. Vedi
-- docs/superpowers/specs/2026-08-29-feed-istantanee-design.md §4.1/§4.2.

create table public.snapshot_reactions (
  id            bigint generated always as identity primary key,
  snapshot_id   bigint not null references public.smokes(id) on delete cascade,
  user_id       uuid   not null references auth.users(id)    on delete cascade,
  reaction_type text   not null check (reaction_type in ('heart','fire','joy','wow','clap')),
  created_at    timestamptz not null default now(),
  unique (snapshot_id, user_id)
);
create index snapshot_reactions_snapshot_idx on public.snapshot_reactions (snapshot_id);

alter table public.snapshot_reactions enable row level security;
create policy "own reactions" on public.snapshot_reactions
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.snapshot_comments (
  id          bigint generated always as identity primary key,
  snapshot_id bigint not null references public.smokes(id) on delete cascade,
  user_id     uuid   not null references auth.users(id)    on delete cascade,
  body        text   not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index snapshot_comments_snapshot_idx on public.snapshot_comments (snapshot_id, created_at);

alter table public.snapshot_comments enable row level security;
create policy "read own comments"   on public.snapshot_comments for select using (user_id = (select auth.uid()));
create policy "insert own comments"  on public.snapshot_comments for insert with check (user_id = (select auth.uid()));
create policy "delete own comments"  on public.snapshot_comments for delete using (user_id = (select auth.uid()));
