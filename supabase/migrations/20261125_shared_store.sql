-- Additive migration. Run after 20261123_payments.sql.
begin;
create table public.shop_products (
  slug text primary key,
  definition jsonb not null,
  stock integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.shop_settings (key text primary key, value text not null default '');
create table public.shop_carts (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  items jsonb not null default '[]', updated_at timestamptz not null default now()
);
create table public.shop_subscribers (
  email text primary key, created_at timestamptz not null default now(),
  provider_synced_at timestamptz
);
alter table public.shop_products enable row level security;
alter table public.shop_settings enable row level security;
alter table public.shop_carts enable row level security;
alter table public.shop_subscribers enable row level security;
revoke all on public.shop_products, public.shop_settings, public.shop_carts, public.shop_subscribers from anon, authenticated;
grant all on public.shop_products, public.shop_settings, public.shop_carts, public.shop_subscribers to service_role;
insert into public.shop_settings(key,value) values ('announcement','');
alter table public.shop_orders add column inventory_reserved boolean not null default false;
alter table public.shop_orders add column reserved_until timestamptz;

-- Lock orders before products, and products in slug order in every inventory operation.
create function public.release_expired_shop_orders() returns void
language plpgsql security invoker set search_path = '' as $$
declare o public.shop_orders; i record;
begin
  for o in select * from public.shop_orders where payment_status='Unpaid' and inventory_reserved
    and reserved_until < now() order by id for update skip locked loop
    for i in select value->>'slug' as slug, sum((value->>'qty')::integer) as qty
      from jsonb_array_elements(o.items) group by value->>'slug' order by value->>'slug' loop
      update public.shop_products set stock=stock+i.qty where slug=i.slug and stock is not null;
    end loop;
    update public.shop_orders set inventory_reserved=false where id=o.id;
  end loop;
end;
$$;

create function public.reserve_shop_order(p_order jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare p public.shop_products; i record; o public.shop_orders;
begin
  perform public.release_expired_shop_orders();
  for i in select value->>'slug' as slug, sum((value->>'qty')::integer) as qty
    from jsonb_array_elements(p_order->'items') group by value->>'slug' order by value->>'slug' loop
    select * into p from public.shop_products where slug=i.slug for update;
    if not found or not p.active or (p.stock is not null and p.stock < i.qty) then raise exception 'Stock unavailable'; end if;
    -- Reject a price/variant changed since the server read the catalogue.
    if exists(select 1 from jsonb_array_elements(p_order->'items') v where v->>'slug'=i.slug and
      ((v->>'price')::bigint <> (p.definition->>'price')::bigint or
       not (p.definition->'sizes' ? (v->>'size')) or
       not exists(select 1 from jsonb_array_elements(p.definition->'colors') c where c->>'id'=v->>'color'))) then
      raise exception 'Catalogue changed';
    end if;
    update public.shop_products set stock=stock-i.qty where slug=i.slug and stock is not null;
  end loop;
  insert into public.shop_orders(id,reference,customer,items,total,inventory_reserved,reserved_until)
    values(p_order->>'id',p_order->>'reference',p_order->'customer',p_order->'items',(p_order->>'total')::bigint,true,now()+interval '30 minutes')
    returning * into o;
  return to_jsonb(o);
end;
$$;

-- Payment received after a reservation expires must still be recorded. Negative
-- inventory records any shortage honestly so the owner can reconcile fulfillment.
create function public.shop_paid_inventory() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare i record;
begin
  if new.payment_status='Paid' and old.payment_status <> 'Paid' and not old.inventory_reserved then
    for i in select value->>'slug' as slug, sum((value->>'qty')::integer) as qty
      from jsonb_array_elements(new.items) group by value->>'slug' order by value->>'slug' loop
      update public.shop_products set stock=stock-i.qty where slug=i.slug and stock is not null;
    end loop;
    new.inventory_reserved=true;
  end if;
  return new;
end;
$$;
create trigger shop_paid_inventory before update of payment_status on public.shop_orders
  for each row execute function public.shop_paid_inventory();

-- A single import per database protects newer shared edits from stale browsers.
create function public.import_shop_browser_data(p_products jsonb, p_hidden jsonb, p_announcement text) returns void
language plpgsql security invoker set search_path = '' as $$
declare p jsonb; s text;
begin
  perform pg_advisory_xact_lock(20261125);
  if exists(select 1 from public.shop_settings where key='browser_import_complete') then return; end if;
  for p in select * from jsonb_array_elements(p_products) loop
    insert into public.shop_products(slug,definition,stock,active) values(p->>'slug',p->'definition',(p->>'stock')::integer,true)
    on conflict(slug) do update set definition=excluded.definition,stock=excluded.stock,updated_at=now();
  end loop;
  for s in select jsonb_array_elements_text(p_hidden) loop
    update public.shop_products set active=false where slug=s;
  end loop;
  if p_announcement <> '' then update public.shop_settings set value=p_announcement where key='announcement'; end if;
  insert into public.shop_settings(key,value) values('browser_import_complete','true');
end;
$$;
revoke execute on function public.release_expired_shop_orders(), public.reserve_shop_order(jsonb), public.shop_paid_inventory(), public.import_shop_browser_data(jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.release_expired_shop_orders(), public.reserve_shop_order(jsonb), public.shop_paid_inventory(), public.import_shop_browser_data(jsonb,jsonb,text) to service_role;
insert into public.shop_products(slug,definition) values ('aether-compression-tee','{"slug":"aether-compression-tee","name":"Aether Compression Tee","category":"Tops","price":148000,"tagline":"Second-skin performance","description":"A raglan compression tee cut for heat, speed, and the hours after. Gold piping traces the shoulders. A gold-to-violet gradient panel runs the side seam. RUNAWAY is set vertically down the spine.","story":"Built as the house kit — the piece you train in, travel in, and refuse to take off. Engineered stretch holds shape through the session. Flatlock seams disappear against skin. A woven hem label is the only signature you need.","images":["tee-front.jpg","tee-back.jpg","lifestyle-tee.jpg","tee-detail-logo.jpg","tee-detail-seam.jpg","tee-detail-sleeve.jpg","tee-detail-hem.jpg"],"colors":[{"id":"eclipse","name":"Black","swatch":"#0c0c0c"},{"id":"white","name":"White","swatch":"#f4f1e8","images":["tee-white-front.jpg"]}],"sizes":["S","M","L","XL","XXL"],"features":[{"label":"Compression knit","detail":"Holds without binding"},{"label":"Raglan mobility","detail":"Unbroken shoulder line"},{"label":"Gold piping","detail":"Traced seams, not printed"},{"label":"Spine mark","detail":"Vertical RUNAWAY lockup"}],"fabric":"Premium stretch jersey with moisture-wicking finish. Mesh-vented gradient side panel.","fit":"Compression. Size up for a training-regular feel."}'::jsonb);
insert into public.shop_products(slug,definition) values ('apex-training-shorts','{"slug":"apex-training-shorts","name":"Apex Training Shorts","category":"Bottoms","price":98000,"tagline":"Cut to move","description":"Lightweight training shorts with a gold-tipped drawcord, side vents, and the dual-runner mark at the thigh. Quiet luxury for the work that happens before sunrise.","story":"A clean short with no extra noise — stretch, breathability, and a slit that opens when you stride. Made for training and the hours that follow.","images":["shorts-front.jpg","shorts-back.jpg","lifestyle-shorts.jpg","shorts-detail-logo.jpg","shorts-detail-vent.jpg","shorts-detail-draw.jpg","shorts-detail-stitch.jpg"],"colors":[{"id":"void","name":"Black","swatch":"#0a0a0a"},{"id":"white","name":"White","swatch":"#f4f1e8","images":["shorts-white-front.jpg"]}],"sizes":["S","M","L","XL","XXL"],"features":[{"label":"Lightweight","detail":"Feather feel in motion"},{"label":"Breathable","detail":"Open knit, fast dry"},{"label":"4-way stretch","detail":"Stride without bind"},{"label":"Moisture wicking","detail":"Pulls heat off skin"}],"fabric":"Four-way stretch woven with a dry-hand finish. Elastic waist, internal drawcord.","fit":"Athletic. Sits at the hip, splits at the stride."}'::jsonb);
insert into public.shop_products(slug,definition) values ('velocity-skull-cap','{"slug":"velocity-skull-cap","name":"Velocity Skull Cap","category":"Accessories","price":42000,"tagline":"Stay locked in","description":"A performance skull cap with ventilated panels, a silicone grip band, and an embossed gold runner. Four colorways — from all black to midnight.","story":"Designed to disappear under a hood or sit alone in the cold start. Moisture-wicking, four-way stretch, feather-light. The grip band keeps it honest when the pace goes up.","images":["lifestyle-cap.jpg","cap-sheet.jpg","cap-colorways.jpg","cap-hero.jpg"],"colors":[{"id":"all-black","name":"All Black","swatch":"#111111"},{"id":"black-gold","name":"Black / Gold","swatch":"#c9a84c"},{"id":"black-silver","name":"Black / Silver","swatch":"#c5c5c8"},{"id":"midnight","name":"Midnight","swatch":"#1b2433"}],"sizes":["S/M","L/XL"],"features":[{"label":"Ventilated","detail":"Breathable panels"},{"label":"Grip band","detail":"Silicone stay-put"},{"label":"Flatlock seams","detail":"No hot spots"},{"label":"Embossed mark","detail":"Gold runner, low profile"}],"fabric":"Premium stretch knit. Moisture-wicking. Feather-light.","fit":"Secure. Choose S/M or L/XL."}'::jsonb);
commit;
