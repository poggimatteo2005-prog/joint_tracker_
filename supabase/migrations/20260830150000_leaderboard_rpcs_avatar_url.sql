-- Le RPC leaderboard/friend-stats ora ritornano anche avatar_url (e username per
-- get_friend_stats), così il client non fa più una query separata su profiles_public
-- per render (elimina l'N+1 e il tetto sulla lunghezza dell'URL della .in(ids) sulla
-- leaderboard mondiale non paginata). Cambi additivi in coda / dopo username.
-- Serve DROP+CREATE perché CREATE OR REPLACE non può cambiare il RETURNS TABLE.
-- Grant ripristinati come prima: solo authenticated + service_role, mai anon/public.

drop function if exists public.get_global_leaderboard();
drop function if exists public.get_friends_leaderboard(uuid);
drop function if exists public.get_friends_shared_leaderboard(text);
drop function if exists public.get_friend_stats(uuid);

CREATE FUNCTION public.get_global_leaderboard()
 RETURNS TABLE(user_id uuid, username text, avatar_url text, total_g numeric, total_j bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.username,
        p.avatar_url,
        COALESCE(SUM(
            GREATEST(
                COALESCE(s.my_fumo_grams, 0) + COALESCE(s.my_erba_grams, 0),
                COALESCE(s.fumo_grams, 0) + COALESCE(s.erba_grams, 0),
                COALESCE(s.grams, 0)
            )
        ), 0)::NUMERIC,
        COUNT(s.id)::BIGINT
    FROM profiles p
    LEFT JOIN smokes s ON s.user_id = p.id
    GROUP BY p.id, p.username, p.avatar_url
    ORDER BY 4 DESC;
END;
$function$;

CREATE FUNCTION public.get_friends_leaderboard(current_user_id uuid)
 RETURNS TABLE(user_id uuid, username text, avatar_url text, total_g numeric, total_j bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        p.id AS user_id,
        p.username,
        p.avatar_url,
        COALESCE(SUM(
            GREATEST(
                COALESCE(s.my_fumo_grams, 0) + COALESCE(s.my_erba_grams, 0),
                COALESCE(s.fumo_grams, 0) + COALESCE(s.erba_grams, 0),
                COALESCE(s.grams, 0)
            )
        ), 0)::NUMERIC AS total_g,
        COUNT(s.id)::BIGINT AS total_j
    FROM profiles p
    LEFT JOIN smokes s ON s.user_id = p.id
    WHERE
        p.id = current_user_id
        OR
        p.id IN (
            SELECT f.friend_id
            FROM friendships f
            WHERE f.user_id = current_user_id AND f.status = 'accepted'
        )
    GROUP BY p.id, p.username, p.avatar_url
    ORDER BY total_g DESC;
END;
$function$;

CREATE FUNCTION public.get_friends_shared_leaderboard(period text DEFAULT 'month'::text)
 RETURNS TABLE(friend_id uuid, username text, avatar_url text, sessions_together bigint, grams_together numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select f.friend_id,
         p.username,
         p.avatar_url,
         count(s.id) filter (
           where s.shared_with @> to_jsonb(array[f.friend_id::text])
           and (period <> 'month' or s.date >= date_trunc('month', current_date))
         ),
         coalesce(sum(s.my_fumo_grams + s.my_erba_grams) filter (
           where s.shared_with @> to_jsonb(array[f.friend_id::text])
           and (period <> 'month' or s.date >= date_trunc('month', current_date))
         ), 0)
  from public.friendships f
  join public.profiles p on p.id = f.friend_id
  left join public.smokes s on s.user_id = auth.uid()
  where f.user_id = auth.uid() and f.status = 'accepted'
  group by f.friend_id, p.username, p.avatar_url
  order by 4 desc;
$function$;

CREATE FUNCTION public.get_friend_stats(target_user_id uuid)
 RETURNS TABLE(fumo_g numeric, erba_g numeric, totale_j bigint, username text, avatar_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(GREATEST(
            COALESCE(s.my_fumo_grams, 0),
            COALESCE(s.fumo_grams, 0),
            CASE WHEN s.type = 'fumo' THEN COALESCE(s.grams, 0) ELSE 0 END
        )), 0)::NUMERIC,
        COALESCE(SUM(GREATEST(
            COALESCE(s.my_erba_grams, 0),
            COALESCE(s.erba_grams, 0),
            CASE WHEN s.type = 'erba' THEN COALESCE(s.grams, 0) ELSE 0 END
        )), 0)::NUMERIC,
        COUNT(s.id)::BIGINT,
        (SELECT p.username FROM profiles p WHERE p.id = target_user_id),
        (SELECT p.avatar_url FROM profiles p WHERE p.id = target_user_id)
    FROM smokes s
    WHERE s.user_id = target_user_id;
END;
$function$;

revoke all on function public.get_global_leaderboard()          from public, anon;
revoke all on function public.get_friends_leaderboard(uuid)      from public, anon;
revoke all on function public.get_friends_shared_leaderboard(text) from public, anon;
revoke all on function public.get_friend_stats(uuid)             from public, anon;
grant execute on function public.get_global_leaderboard()          to authenticated, service_role;
grant execute on function public.get_friends_leaderboard(uuid)      to authenticated, service_role;
grant execute on function public.get_friends_shared_leaderboard(text) to authenticated, service_role;
grant execute on function public.get_friend_stats(uuid)             to authenticated, service_role;

-- ROLLBACK: drop + ricreare le definizioni precedenti (RETURNS senza avatar_url,
-- ORDER BY 3 in get_global_leaderboard / get_friends_shared_leaderboard) da
-- 20260819160000_fix_shared_session_personal_stats.sql e migration originali,
-- + stessi grant.
