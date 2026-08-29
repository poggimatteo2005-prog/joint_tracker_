-- RPC di lettura per il feed istantanee. SECURITY DEFINER perché fanno join
-- cross-utente su smokes/profiles/friendships, che la RLS vieta; ogni funzione
-- filtra con can_see_snapshot (stessa visibilità di get_friends_snapshots).
-- Vedi spec §5.1/§5.2 e CLAUDE.md.

create or replace function public.can_see_snapshot(p_snapshot_id bigint)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.smokes s
    where s.id = p_snapshot_id
      and s.photo_path is not null
      and (
        s.user_id = (select auth.uid())
        or exists (
          select 1 from public.friendships f
          where f.user_id = (select auth.uid()) and f.friend_id = s.user_id and f.status = 'accepted'
        )
      )
  );
$$;

create or replace function public.snapshot_reaction_summary(p_snapshot_id bigint)
returns jsonb language sql security definer set search_path = public stable as $$
  select coalesce(jsonb_object_agg(t.reaction_type, t.cnt), '{}'::jsonb)
  from (
    select reaction_type, count(*)::int as cnt
    from public.snapshot_reactions
    where snapshot_id = p_snapshot_id
    group by reaction_type
  ) t;
$$;

create or replace function public.get_snapshot_feed(limit_count int default 20)
returns table (
  id bigint, user_id uuid, username text, avatar_url text,
  ts bigint, date date, "time" text, type text,
  my_fumo_grams numeric, my_erba_grams numeric, location_name text, photo_path text,
  reaction_summary jsonb, my_reaction text, comment_count int
)
language sql security definer set search_path = public as $$
  select
    s.id, s.user_id, p.username, p.avatar_url,
    s.ts, s.date, s.time, s.type,
    s.my_fumo_grams, s.my_erba_grams, s.location_name, s.photo_path,
    public.snapshot_reaction_summary(s.id) as reaction_summary,
    (select r.reaction_type from public.snapshot_reactions r
       where r.snapshot_id = s.id and r.user_id = (select auth.uid())) as my_reaction,
    (select count(*)::int from public.snapshot_comments c where c.snapshot_id = s.id) as comment_count
  from public.smokes s
  join public.profiles p on p.id = s.user_id
  where s.photo_path is not null
    and (
      s.user_id = (select auth.uid())
      or s.user_id in (
        select f.friend_id from public.friendships f
        where f.user_id = (select auth.uid()) and f.status = 'accepted'
      )
    )
  order by s.ts desc
  limit limit_count;
$$;

create or replace function public.get_snapshot_comments(p_snapshot_id bigint)
returns table (id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to view this snapshot' using errcode = '42501';
  end if;
  return query
    select c.id, c.user_id, p.username, p.avatar_url, c.body, c.created_at,
           (c.user_id = (select auth.uid())) as is_mine
    from public.snapshot_comments c
    join public.profiles p on p.id = c.user_id
    where c.snapshot_id = p_snapshot_id
    order by c.created_at asc;
end $$;

revoke all on function public.can_see_snapshot(bigint)          from public, anon;
revoke all on function public.snapshot_reaction_summary(bigint)  from public, anon;
revoke all on function public.get_snapshot_feed(int)             from public, anon;
revoke all on function public.get_snapshot_comments(bigint)      from public, anon;
grant execute on function public.can_see_snapshot(bigint)         to authenticated;
grant execute on function public.snapshot_reaction_summary(bigint) to authenticated;
grant execute on function public.get_snapshot_feed(int)           to authenticated;
grant execute on function public.get_snapshot_comments(bigint)    to authenticated;
