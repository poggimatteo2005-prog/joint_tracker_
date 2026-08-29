-- RPC di scrittura per reazioni/commenti + generazione notifiche aggregate.
-- SECURITY DEFINER: scrivono righe legate a istantanee di altri utenti e
-- inseriscono notifiche sull'account del proprietario (la RLS di notifications
-- non concede INSERT ai client). Ogni funzione filtra con can_see_snapshot e
-- scrive sempre con user_id = auth.uid(). Vedi spec §5.3/§5.4 e CLAUDE.md.

create or replace function public.notify_snapshot_engagement(p_owner uuid, p_type text, p_snapshot_id bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, type, snapshot_id, bucket_date, event_count, message)
  values (p_owner, p_type, p_snapshot_id, (now() at time zone 'utc')::date, 1, null)
  on conflict (user_id, type, snapshot_id, bucket_date) where type in ('snapshot_reaction','snapshot_comment')
  do update set event_count = public.notifications.event_count + 1,
                read = false,
                updated_at = now();
$$;

create or replace function public.set_snapshot_reaction(p_snapshot_id bigint, p_reaction_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if p_reaction_type not in ('heart','fire','joy','wow','clap') then
    raise exception 'Invalid reaction type: %', p_reaction_type;
  end if;
  select user_id into v_owner from public.smokes where id = p_snapshot_id and photo_path is not null;
  if v_owner is null or not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to react to this snapshot' using errcode = '42501';
  end if;
  insert into public.snapshot_reactions (snapshot_id, user_id, reaction_type)
  values (p_snapshot_id, (select auth.uid()), p_reaction_type)
  on conflict (snapshot_id, user_id)
  do update set reaction_type = excluded.reaction_type, created_at = now();
  if v_owner <> (select auth.uid()) then
    perform public.notify_snapshot_engagement(v_owner, 'snapshot_reaction', p_snapshot_id);
  end if;
  return public.snapshot_reaction_summary(p_snapshot_id);
end $$;

create or replace function public.remove_snapshot_reaction(p_snapshot_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from public.snapshot_reactions
  where snapshot_id = p_snapshot_id and user_id = (select auth.uid());
  return public.snapshot_reaction_summary(p_snapshot_id);
end $$;

create or replace function public.add_snapshot_comment(p_snapshot_id bigint, p_body text)
returns table (id bigint, user_id uuid, username text, avatar_url text, body text, created_at timestamptz, is_mine boolean)
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_body text; v_id bigint;
begin
  v_body := trim(p_body);
  if v_body = '' or char_length(v_body) > 500 then
    raise exception 'Invalid comment length';
  end if;
  select s.user_id into v_owner from public.smokes s where s.id = p_snapshot_id and s.photo_path is not null;
  if v_owner is null or not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed to comment on this snapshot' using errcode = '42501';
  end if;
  insert into public.snapshot_comments (snapshot_id, user_id, body)
  values (p_snapshot_id, (select auth.uid()), v_body)
  returning snapshot_comments.id into v_id;
  if v_owner <> (select auth.uid()) then
    perform public.notify_snapshot_engagement(v_owner, 'snapshot_comment', p_snapshot_id);
  end if;
  return query
    select c.id, c.user_id, p.username, p.avatar_url, c.body, c.created_at, true
    from public.snapshot_comments c
    join public.profiles p on p.id = c.user_id
    where c.id = v_id;
end $$;

create or replace function public.delete_snapshot_comment(p_comment_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_rows int;
begin
  delete from public.snapshot_comments
  where id = p_comment_id and user_id = (select auth.uid());
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Comment not found or not yours';
  end if;
end $$;

revoke all on function public.notify_snapshot_engagement(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.set_snapshot_reaction(bigint, text)   from public, anon;
revoke all on function public.remove_snapshot_reaction(bigint)      from public, anon;
revoke all on function public.add_snapshot_comment(bigint, text)    from public, anon;
revoke all on function public.delete_snapshot_comment(bigint)       from public, anon;
grant execute on function public.set_snapshot_reaction(bigint, text) to authenticated;
grant execute on function public.remove_snapshot_reaction(bigint)    to authenticated;
grant execute on function public.add_snapshot_comment(bigint, text)  to authenticated;
grant execute on function public.delete_snapshot_comment(bigint)     to authenticated;
