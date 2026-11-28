-- Generate a private copy with: npm run prepare:scheduler -- https://YOUR_PUBLIC_HOST
-- Run that generated copy in this project's Supabase SQL Editor after deployment.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $setup$
declare secret_id uuid;
begin
  if to_regclass('vault.decrypted_secrets') is null then raise exception 'Enable Supabase Vault before configuring the scheduler'; end if;
  if '__RUNAWAY_PUBLIC_ORIGIN__' like '%__RUNAWAY_%' then raise exception 'Generate the configured scheduler SQL first'; end if;
  select id into secret_id from vault.secrets where name='runaway_site_url';
  if secret_id is null then perform vault.create_secret('__RUNAWAY_PUBLIC_ORIGIN__','runaway_site_url');
  else perform vault.update_secret(secret_id,'__RUNAWAY_PUBLIC_ORIGIN__'); end if;
  select id into secret_id from vault.secrets where name='runaway_retry_secret';
  if secret_id is null then perform vault.create_secret('__RUNAWAY_CRON_SECRET__','runaway_retry_secret');
  else perform vault.update_secret(secret_id,'__RUNAWAY_CRON_SECRET__'); end if;
end;
$setup$;
create or replace function public.dispatch_shop_maintenance() returns bigint
language plpgsql security definer set search_path='' as $$
declare site_url text; token text; request_id bigint;
begin
  select decrypted_secret into site_url from vault.decrypted_secrets where name='runaway_site_url';
  select decrypted_secret into token from vault.decrypted_secrets where name='runaway_retry_secret';
  if site_url is null or token is null then raise exception 'Scheduler settings missing'; end if;
  select net.http_get(url:=site_url||'/api/email-retry',headers:=jsonb_build_object('Authorization','Bearer '||token),timeout_milliseconds:=55000) into request_id;
  insert into public.shop_settings(key,value) values('maintenance_request_id',request_id::text)
    on conflict(key) do update set value=excluded.value;
  return request_id;
end;
$$;
revoke all on function public.dispatch_shop_maintenance() from public,anon,authenticated;
do $jobs$
declare old_job record;
begin
  for old_job in select jobid from cron.job where jobname='runaway-email-retry' loop perform cron.unschedule(old_job.jobid); end loop;
end;
$jobs$;
select cron.schedule('runaway-email-retry','* * * * *','select public.dispatch_shop_maintenance()');
commit;
-- Confirm real HTTP success in net._http_response; a successful cron run alone
-- only proves that an HTTP request was queued, not that the website processed it.
