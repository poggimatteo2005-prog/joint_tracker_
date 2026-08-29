-- Follow-up dal final review del feed istantanee.

-- snapshot_reaction_summary non ha un gate di visibilità e non ha chiamanti client
-- legittimi (solo get_snapshot_feed / set_snapshot_reaction / remove_snapshot_reaction,
-- tutte SECURITY DEFINER che girano come owner). Revoca l'accesso diretto.
revoke execute on function public.snapshot_reaction_summary(bigint) from anon, authenticated, public;

-- Conteggio engagement per la conferma di cancellazione (path Galleria, dove il feed
-- non è caricato). Gated su can_see_snapshot (per il proprietario è sempre true).
create or replace function public.snapshot_engagement_counts(p_snapshot_id bigint)
returns table (reaction_count int, comment_count int)
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_see_snapshot(p_snapshot_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select (select count(*)::int from public.snapshot_reactions r where r.snapshot_id = p_snapshot_id),
           (select count(*)::int from public.snapshot_comments  c where c.snapshot_id = p_snapshot_id);
end $$;
revoke all on function public.snapshot_engagement_counts(bigint) from public, anon;
grant execute on function public.snapshot_engagement_counts(bigint) to authenticated;

-- Indice per il nuovo ordinamento notifiche (loadNotifications ora ordina per updated_at).
create index if not exists notifications_user_updated_idx on public.notifications (user_id, updated_at desc);
-- Indice per il cascade FK / trigger su notifications.snapshot_id.
create index if not exists notifications_snapshot_id_idx on public.notifications (snapshot_id);
