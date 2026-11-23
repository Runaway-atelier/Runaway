-- Run once in the Supabase SQL editor. No browser access to customer records.
begin;
create table public.shop_orders (
  id text primary key,
  reference text unique not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  customer jsonb not null,
  items jsonb not null,
  total bigint not null check (total > 0),
  payment_status text not null default 'Unpaid' check (payment_status in ('Unpaid', 'Paid')),
  transaction_id text unique,
  fulfillment_status text not null default 'Pending' check (fulfillment_status in ('Pending', 'Packing', 'Shipped', 'Delivered', 'Cancelled')),
  courier text not null default '',
  tracking_number text not null default ''
);
create table public.shop_email_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.shop_orders(id),
  kind text not null check (kind in ('customer', 'store')),
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'review')),
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  lease_token uuid,
  resend_id text unique,
  last_error text,
  unique(order_id, kind)
);
create index shop_email_due on public.shop_email_outbox(next_attempt_at) where state in ('pending', 'sending');
create table public.shop_email_events (
  email_id text primary key,
  event_type text not null,
  event_at timestamptz not null
);
alter table public.shop_orders enable row level security;
alter table public.shop_email_outbox enable row level security;
alter table public.shop_email_events enable row level security;
revoke all on public.shop_orders, public.shop_email_outbox, public.shop_email_events from anon, authenticated;
grant all on public.shop_orders, public.shop_email_outbox, public.shop_email_events to service_role;

-- Payment status and both notification jobs commit in a single transaction.
create function public.settle_shop_order(p_reference text, p_transaction_id text, p_paid_at timestamptz, p_amount bigint, p_messages jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare o public.shop_orders; m jsonb;
begin
  select * into o from public.shop_orders where reference = p_reference for update;
  if not found or o.total * 100 <> p_amount then raise exception 'Payment mismatch'; end if;
  if o.payment_status = 'Paid' then
    if o.transaction_id <> p_transaction_id then raise exception 'Transaction mismatch'; end if;
    return to_jsonb(o);
  end if;
  if jsonb_array_length(p_messages) <> 2 then raise exception 'Two notifications required'; end if;
  update public.shop_orders set payment_status = 'Paid', transaction_id = p_transaction_id, paid_at = p_paid_at
    where id = o.id returning * into o;
  for m in select * from jsonb_array_elements(p_messages) loop
    if coalesce(m->'payload'->>'from', '') = '' or coalesce(m->'payload'->'to'->>0, '') = '' then raise exception 'Sender or recipient missing'; end if;
    insert into public.shop_email_outbox(order_id, kind, payload) values (o.id, m->>'kind', m->'payload');
  end loop;
  return to_jsonb(o);
end;
$$;

create function public.claim_shop_emails() returns setof public.shop_email_outbox
language plpgsql security invoker set search_path = '' as $$
begin
  -- Resend deduplicates for 24h. After 23h, an ambiguous send requires review
  -- rather than risking an automatic duplicate after that window expires.
  update public.shop_email_outbox set state = 'review', last_error = 'Retry window expired; reconcile in Resend before resending.'
    where state in ('pending', 'sending') and first_attempt_at < now() - interval '23 hours'
      and (locked_until is null or locked_until < now());
  return query
    with due as (
      select id from public.shop_email_outbox
      where ((state = 'pending' and next_attempt_at <= now()) or (state = 'sending' and locked_until < now()))
        and (first_attempt_at is null or first_attempt_at >= now() - interval '23 hours')
      order by next_attempt_at for update skip locked limit 2
    )
    update public.shop_email_outbox e set state = 'sending', attempts = attempts + 1,
      first_attempt_at = coalesce(first_attempt_at, now()), locked_until = now() + interval '2 minutes', lease_token = gen_random_uuid()
    from due where e.id = due.id returning e.*;
end;
$$;

-- Events may precede the send-response database write; retain them independently.
create function public.record_shop_email_event(p_email_id text, p_type text, p_at timestamptz)
returns void language sql security invoker set search_path = '' as $$
  insert into public.shop_email_events(email_id, event_type, event_at) values (p_email_id, p_type, p_at)
  on conflict(email_id) do update set event_type = excluded.event_type, event_at = excluded.event_at
  where public.shop_email_events.event_at < excluded.event_at;
$$;
revoke execute on function public.settle_shop_order(text,text,timestamptz,bigint,jsonb), public.claim_shop_emails(), public.record_shop_email_event(text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.settle_shop_order(text,text,timestamptz,bigint,jsonb), public.claim_shop_emails(), public.record_shop_email_event(text,text,timestamptz) to service_role;
commit;
