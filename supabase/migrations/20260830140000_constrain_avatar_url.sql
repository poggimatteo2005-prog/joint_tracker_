-- profiles.avatar_url is now client-writable (avatar feature). RLS lets a user
-- write any string to their own row; without this, avatar_url could be set to an
-- arbitrary remote URL that avatarMarkup() would render as <img src> into every
-- other user's leaderboard (privacy beacon / unmoderatable content).
-- Allowed shapes: null | preset:<key> | the avatars bucket public URL prefix.
alter table public.profiles
  add constraint profiles_avatar_url_shape check (
    avatar_url is null
    or avatar_url like 'preset:%'
    or avatar_url like 'https://afkxmbxcavwhurmdelfr.supabase.co/storage/v1/object/public/avatars/%'
  );

-- ROLLBACK: alter table public.profiles drop constraint profiles_avatar_url_shape;
