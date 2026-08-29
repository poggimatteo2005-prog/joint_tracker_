-- "Cancellare un'istantanea" = smokes.photo_path passa a NULL (la sessione resta
-- loggata), quindi l'ON DELETE CASCADE delle FK non scatta. Questo trigger fa il
-- cascade di reazioni/commenti/notifiche in quel caso; sul DELETE vero della riga
-- le FK cascade fanno già il lavoro e qui i DELETE sono no-op innocui. Vedi spec §4.4.

create or replace function public.cascade_snapshot_engagement_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and not (old.photo_path is not null and new.photo_path is null) then
    return null;
  end if;
  delete from public.snapshot_reactions where snapshot_id = old.id;
  delete from public.snapshot_comments  where snapshot_id = old.id;
  delete from public.notifications      where snapshot_id = old.id;
  return null;
end $$;

drop trigger if exists trg_smokes_snapshot_cleanup_upd on public.smokes;
create trigger trg_smokes_snapshot_cleanup_upd
  after update of photo_path on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();

drop trigger if exists trg_smokes_snapshot_cleanup_del on public.smokes;
create trigger trg_smokes_snapshot_cleanup_del
  after delete on public.smokes
  for each row execute function public.cascade_snapshot_engagement_delete();

revoke all on function public.cascade_snapshot_engagement_delete() from public, anon, authenticated;

-- Contatore engagement, interrogabile via SQL/MCP (punto 7 del prompt). Nessuna UI.
-- security_invoker: la vista è interrogata come postgres via MCP, nessun uso client.
create or replace view public.snapshot_engagement
with (security_invoker = true) as
select s.id as snapshot_id, s.user_id as owner_id,
       (select count(*) from public.snapshot_reactions r where r.snapshot_id = s.id) as reaction_count,
       (select count(*) from public.snapshot_comments  c where c.snapshot_id = s.id) as comment_count
from public.smokes s
where s.photo_path is not null;
