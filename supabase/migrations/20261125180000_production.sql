-- Apply after 20261125_shared_store.sql. Preserves existing orders and catalogue.
begin;
alter table public.shop_orders add column payment_environment text not null default 'test'
  check (payment_environment in ('test','live'));
alter table public.shop_products add column test_stock integer;
update public.shop_products set test_stock=stock;
-- Existing integration orders were test-only. Restore their reserved units to
-- real inventory while keeping the test inventory balance unchanged.
update public.shop_products p set stock=p.stock+r.qty from (
  select i->>'slug' as slug,sum((i->>'qty')::integer)::integer as qty
  from public.shop_orders o cross join lateral jsonb_array_elements(o.items) i
  where o.inventory_reserved and o.payment_environment='test' group by i->>'slug'
) r where p.slug=r.slug and p.stock is not null;
create index shop_orders_environment on public.shop_orders(payment_environment,created_at desc);

create table public.shop_request_limits (
  key text primary key, hits integer not null, expires_at timestamptz not null
);
create index shop_request_limits_expiry on public.shop_request_limits(expires_at);
alter table public.shop_request_limits enable row level security;
revoke all on public.shop_request_limits from anon, authenticated;
grant all on public.shop_request_limits to service_role;
create function public.consume_shop_request(p_key text,p_limit integer,p_seconds integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.shop_request_limits;
begin
  if p_key !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_seconds < 1 or p_seconds > 86400 then raise exception 'Invalid request limit'; end if;
  insert into public.shop_request_limits(key,hits,expires_at) values(p_key,1,now()+make_interval(secs=>p_seconds))
  on conflict(key) do update set hits=case when public.shop_request_limits.expires_at<=now() then 1 else least(public.shop_request_limits.hits,1000000)+1 end,
    expires_at=case when public.shop_request_limits.expires_at<=now() then excluded.expires_at else public.shop_request_limits.expires_at end
  returning * into r;
  return jsonb_build_object('allowed',r.hits<=p_limit,'retry_after',greatest(1,ceil(extract(epoch from r.expires_at-now()))::integer));
end;
$$;

create or replace function public.release_expired_shop_orders() returns void
language plpgsql security invoker set search_path='' as $$
declare o public.shop_orders; i record;
begin
  for o in select * from public.shop_orders where payment_status='Unpaid' and inventory_reserved
    and reserved_until<now() order by id for update skip locked loop
    for i in select value->>'slug' as slug,sum((value->>'qty')::integer) as qty
      from jsonb_array_elements(o.items) group by value->>'slug' order by value->>'slug' loop
      if o.payment_environment='test' then
        update public.shop_products set test_stock=test_stock+i.qty where slug=i.slug and test_stock is not null;
      else
        update public.shop_products set stock=stock+i.qty where slug=i.slug and stock is not null;
      end if;
    end loop;
    update public.shop_orders set inventory_reserved=false where id=o.id;
  end loop;
end;
$$;

create or replace function public.reserve_shop_order(p_order jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.shop_products; i record; o public.shop_orders; env text; available integer;
begin
  env:=coalesce(p_order->>'payment_environment','test');
  if env not in ('test','live') then raise exception 'Invalid payment environment'; end if;
  perform public.release_expired_shop_orders();
  for i in select value->>'slug' as slug,sum((value->>'qty')::integer) as qty
    from jsonb_array_elements(p_order->'items') group by value->>'slug' order by value->>'slug' loop
    select * into p from public.shop_products where slug=i.slug for update;
    available:=case when env='test' then p.test_stock else p.stock end;
    if not found or not p.active or (available is not null and available<i.qty) then raise exception 'Stock unavailable'; end if;
    if exists(select 1 from jsonb_array_elements(p_order->'items') v where v->>'slug'=i.slug and
      ((v->>'price')::bigint<>(p.definition->>'price')::bigint or not(p.definition->'sizes' ? (v->>'size')) or
       not exists(select 1 from jsonb_array_elements(p.definition->'colors') c where c->>'id'=v->>'color'))) then
      raise exception 'Catalogue changed';
    end if;
    if env='test' then
      update public.shop_products set test_stock=test_stock-i.qty where slug=i.slug and test_stock is not null;
    else
      update public.shop_products set stock=stock-i.qty where slug=i.slug and stock is not null;
    end if;
  end loop;
  insert into public.shop_orders(id,reference,customer,items,total,inventory_reserved,reserved_until,payment_environment)
    values(p_order->>'id',p_order->>'reference',p_order->'customer',p_order->'items',(p_order->>'total')::bigint,true,now()+interval '30 minutes',env)
    returning * into o;
  return to_jsonb(o);
end;
$$;

create or replace function public.shop_paid_inventory() returns trigger
language plpgsql security invoker set search_path='' as $$
declare i record;
begin
  if new.payment_status='Paid' and old.payment_status<>'Paid' and not old.inventory_reserved then
    for i in select value->>'slug' as slug,sum((value->>'qty')::integer) as qty
      from jsonb_array_elements(new.items) group by value->>'slug' order by value->>'slug' loop
      if new.payment_environment='test' then
        update public.shop_products set test_stock=test_stock-i.qty where slug=i.slug and test_stock is not null;
      else
        update public.shop_products set stock=stock-i.qty where slug=i.slug and stock is not null;
      end if;
    end loop;
    new.inventory_reserved=true;
  end if;
  return new;
end;
$$;

-- Only jobs belonging to the current payment environment may be sent by a worker.
drop function public.claim_shop_emails();
create function public.claim_shop_emails(p_environment text default 'test') returns setof public.shop_email_outbox
language plpgsql security invoker set search_path='' as $$
begin
  if p_environment not in ('test','live') then raise exception 'Invalid payment environment'; end if;
  update public.shop_email_outbox e set state='review',last_error='Retry window expired; reconcile in Resend before resending.'
    where e.state in ('pending','sending') and e.first_attempt_at<now()-interval '23 hours'
      and(e.locked_until is null or e.locked_until<now())
      and exists(select 1 from public.shop_orders o where o.id=e.order_id and o.payment_environment=p_environment);
  return query
    with due as (
      select e.id from public.shop_email_outbox e join public.shop_orders o on o.id=e.order_id
      where o.payment_environment=p_environment and
        ((e.state='pending' and e.next_attempt_at<=now()) or(e.state='sending' and e.locked_until<now()))
        and(e.first_attempt_at is null or e.first_attempt_at>=now()-interval '23 hours')
      order by e.next_attempt_at for update of e skip locked limit 2
    )
    update public.shop_email_outbox e set state='sending',attempts=e.attempts+1,
      first_attempt_at=coalesce(e.first_attempt_at,now()),locked_until=now()+interval '2 minutes',lease_token=gen_random_uuid()
    from due where e.id=due.id returning e.*;
end;
$$;

create or replace function public.import_shop_browser_data(p_products jsonb,p_hidden jsonb,p_announcement text) returns void
language plpgsql security invoker set search_path='' as $$
declare p jsonb; s text;
begin
  perform pg_advisory_xact_lock(20261125);
  if exists(select 1 from public.shop_settings where key='browser_import_complete') then return; end if;
  for p in select * from jsonb_array_elements(p_products) loop
    insert into public.shop_products(slug,definition,stock,test_stock,active)
      values(p->>'slug',p->'definition',(p->>'stock')::integer,(p->>'stock')::integer,true)
    on conflict(slug) do update set definition=excluded.definition,stock=excluded.stock,test_stock=excluded.test_stock,updated_at=now();
  end loop;
  for s in select jsonb_array_elements_text(p_hidden) loop
    update public.shop_products set active=false where slug=s;
  end loop;
  if p_announcement<>'' then update public.shop_settings set value=p_announcement where key='announcement'; end if;
  insert into public.shop_settings(key,value) values('browser_import_complete','true');
end;
$$;

create function public.maintain_shop() returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform public.release_expired_shop_orders();
  delete from public.shop_request_limits where expires_at<now()-interval '1 day';
end;
$$;
revoke execute on function public.consume_shop_request(text,integer,integer), public.claim_shop_emails(text), public.maintain_shop() from public,anon,authenticated;
grant execute on function public.consume_shop_request(text,integer,integer), public.claim_shop_emails(text), public.maintain_shop() to service_role;
commit;
