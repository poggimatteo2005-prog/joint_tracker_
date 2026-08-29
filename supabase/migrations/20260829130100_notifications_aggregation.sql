-- Aggregazione notifiche per le istantanee: una riga per (destinatario, tipo,
-- istantanea, giorno solare UTC) che si incrementa via INSERT … ON CONFLICT.
-- Le righe legacy (snapshot_id/bucket_date NULL) restano invariate e non
-- collidono nell'indice parziale. Vedi spec §4.3.
-- Si rende inoltre `message` nullable: le righe aggregate delle istantanee non
-- hanno un testo statico (il testo è derivato client-side da event_count).

alter table public.notifications
  add column snapshot_id bigint references public.smokes(id) on delete cascade,
  add column event_count int not null default 1,
  add column bucket_date date,
  add column updated_at  timestamptz not null default now();

alter table public.notifications alter column message drop not null;

update public.notifications set updated_at = created_at;

create unique index notifications_daily_agg
  on public.notifications (user_id, type, snapshot_id, bucket_date)
  where type in ('snapshot_reaction','snapshot_comment');
