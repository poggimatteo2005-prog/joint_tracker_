-- Bucket avatar: lettura pubblica (niente signed URL — gli avatar sono già
-- esposti a ogni utente loggato via profiles_public, e pubblici sono cacheabili
-- dalla CDN). Scrittura consentita solo sul proprio prefisso {auth.uid()}/.
-- Path convention: {user_id}/avatar.webp  (o avatar.jpg in fallback).
-- Backstop server-side: limite 2 MB + solo mime immagine (il client carica
-- comunque un 256x256 generato da canvas, ma questo blocca upload abusivi via API).
-- Vedi docs/superpowers/specs/2026-08-30-avatar-utente-design.md §6.1.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/webp','image/jpeg','image/png'];

create policy "Avatar: lettura pubblica"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

create policy "Avatar: insert solo proprio prefisso"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Avatar: update solo proprio prefisso"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Avatar: delete solo proprio prefisso"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ROLLBACK:
-- drop policy "Avatar: lettura pubblica" on storage.objects;
-- drop policy "Avatar: insert solo proprio prefisso" on storage.objects;
-- drop policy "Avatar: update solo proprio prefisso" on storage.objects;
-- drop policy "Avatar: delete solo proprio prefisso" on storage.objects;
-- delete from storage.buckets where id = 'avatars';   -- solo se il bucket è vuoto
