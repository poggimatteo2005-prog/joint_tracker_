-- Owner-only admin dashboard aggregate.
-- SECURITY DEFINER: reads auth.users + every user's smokes/tolerance_breaks/profiles,
-- which normal RLS forbids. Gated by a hardcoded email check on the caller JWT.
-- Execute granted only to `authenticated` (revoked from anon/public).

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
	v_total_users int;
	result jsonb;
begin
	if coalesce(auth.jwt() ->> 'email', '') <> 'poggi.matteo.2005@gmail.com' then
		raise exception 'not authorized' using errcode = '42501';
	end if;

	select count(*) into v_total_users from auth.users;

	with
	user_days as (
		select distinct user_id, date as d
		from public.smokes
		where not_mine is not true
	),
	islands as (
		select user_id, d,
		       d - (row_number() over (partition by user_id order by d))::int as grp
		from user_days
	),
	current_run as (
		select i.user_id, count(*) as run_len, max(i.d) as last_day
		from islands i
		where i.grp = (
			select i2.grp from islands i2
			where i2.user_id = i.user_id
			order by i2.d desc
			limit 1
		)
		group by i.user_id
	),
	user_streak as (
		select u.id as user_id,
		       case when cr.last_day is null or cr.last_day < current_date - 1
		            then 0 else cr.run_len end as streak
		from auth.users u
		left join current_run cr on cr.user_id = u.id
	),
	streak_buckets as (
		select
			count(*) filter (where streak = 0)             as zero,
			count(*) filter (where streak between 1 and 7)  as d1_7,
			count(*) filter (where streak between 8 and 30) as d8_30,
			count(*) filter (where streak >= 31)            as d31_plus
		from user_streak
	),
	day_series as (
		select generate_series(current_date - 29, current_date, interval '1 day')::date as day
	),
	signups_g as (
		select created_at::date as day, count(*) as c
		from auth.users
		where created_at >= current_date - 29
		group by 1
	),
	signups_by_day as (
		select jsonb_agg(
			jsonb_build_object('day', to_char(ds.day, 'YYYY-MM-DD'), 'count', coalesce(s.c, 0))
			order by ds.day
		) as arr
		from day_series ds left join signups_g s on s.day = ds.day
	),
	sessions_g as (
		select date as day, count(*) as c
		from public.smokes
		where not_mine is not true and date >= current_date - 29
		group by 1
	),
	sessions_by_day as (
		select jsonb_agg(
			jsonb_build_object('day', to_char(ds.day, 'YYYY-MM-DD'), 'count', coalesce(s.c, 0))
			order by ds.day
		) as arr
		from day_series ds left join sessions_g s on s.day = ds.day
	),
	shared_users as (
		select distinct user_id
		from public.smokes
		where not_mine is true
		   or (shared_with is not null
		       and jsonb_typeof(shared_with) = 'array'
		       and jsonb_array_length(shared_with) > 0)
	),
	break_users as (
		select distinct user_id from public.tolerance_breaks
	),
	leaderboard_users as (
		select distinct s.user_id
		from public.smokes s
		join public.profiles p on p.id = s.user_id
		where s.not_mine is not true and p.username is not null
	),
	recent as (
		select u.id, u.created_at, p.username,
		       (select count(*) from public.smokes s
		        where s.user_id = u.id and s.not_mine is not true) as session_count
		from auth.users u
		left join public.profiles p on p.id = u.id
		order by u.created_at desc
		limit 20
	),
	recent_json as (
		select jsonb_agg(
			jsonb_build_object(
				'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				'username', username,
				'session_count', session_count
			) order by created_at desc
		) as arr
		from recent
	)
	select jsonb_build_object(
		'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'growth', jsonb_build_object(
			'total_users', v_total_users,
			'new_users', jsonb_build_object(
				'today', (select count(*) from auth.users where created_at::date = current_date),
				'd7',    (select count(*) from auth.users where created_at >= now() - interval '7 days'),
				'd30',   (select count(*) from auth.users where created_at >= now() - interval '30 days')
			),
			'new_users_prev', jsonb_build_object(
				'd7',  (select count(*) from auth.users
				        where created_at >= now() - interval '14 days'
				          and created_at <  now() - interval '7 days'),
				'd30', (select count(*) from auth.users
				        where created_at >= now() - interval '60 days'
				          and created_at <  now() - interval '30 days')
			),
			'signups_by_day', coalesce((select arr from signups_by_day), '[]'::jsonb)
		),
		'usage', jsonb_build_object(
			'total_sessions', (select count(*) from public.smokes where not_mine is not true),
			'sessions_7', (select count(*) from public.smokes
			               where not_mine is not true and date >= current_date - 6),
			'sessions_by_day_30', coalesce((select arr from sessions_by_day), '[]'::jsonb),
			'avg_sessions_per_user', round(
				(select count(*) from public.smokes where not_mine is not true)::numeric
				/ nullif(v_total_users, 0), 1),
			'dau', (select count(distinct user_id) from public.smokes
			        where not_mine is not true and created_at >= now() - interval '24 hours'),
			'mau', (select count(distinct user_id) from public.smokes
			        where not_mine is not true and created_at >= now() - interval '30 days'),
			'dau_mau_pct', round(
				100.0 * (select count(distinct user_id) from public.smokes
				         where not_mine is not true and created_at >= now() - interval '24 hours')
				/ nullif((select count(distinct user_id) from public.smokes
				          where not_mine is not true and created_at >= now() - interval '30 days'), 0), 1)
		),
		'adoption', jsonb_build_object(
			'pct_shared_session', round(100.0 * (select count(*) from shared_users) / nullif(v_total_users, 0), 1),
			'pct_tolerance_break', round(100.0 * (select count(*) from break_users) / nullif(v_total_users, 0), 1),
			'pct_in_leaderboard', round(100.0 * (select count(*) from leaderboard_users) / nullif(v_total_users, 0), 1),
			'streak_buckets', (select jsonb_build_object(
				'zero', zero, 'd1_7', d1_7, 'd8_30', d8_30, 'd31_plus', d31_plus) from streak_buckets)
		),
		'recent_users', coalesce((select arr from recent_json), '[]'::jsonb)
	) into result;

	return result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
