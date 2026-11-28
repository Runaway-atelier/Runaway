import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { schedulerSql } from '../scripts/prepare-scheduler.mjs';
test('deployment build publishes storefront assets and excludes private project files', async () => {
  const result=spawnSync(process.execPath,['scripts/build.mjs'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  for(const path of ['index.html','collection.html','admin/login.html','admin/admin.js','js/site.js','products/product.html'])assert.ok(existsSync('dist/'+path),path);
  for(const path of ['.env.local','.env.example','.git','scratch','lib','api','supabase','tests','package.json'])assert.equal(existsSync('dist/'+path),false,path);
  const config=JSON.parse(await readFile('vercel.json','utf8'));
  assert.equal(config.outputDirectory,'dist');
  assert.equal(config.buildCommand,'npm run build');
});
test('scheduler setup keeps one job and dispatches the configured private authorization header', async () => {
  const database=new PGlite();
  const secret="fixture-scheduler-secret-with-a-quote-'and-32-characters";
  try{
    await database.exec(`
      create role anon; create role authenticated;
      create schema vault; create schema cron; create schema net;
      create table public.shop_settings(key text primary key,value text);
      create table public.http_calls(id bigint generated always as identity primary key,url text,headers jsonb);
      create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,decrypted_secret text);
      create view vault.decrypted_secrets as select * from vault.secrets;
      create function vault.create_secret(value text,secret_name text) returns uuid language sql as 'insert into vault.secrets(name,decrypted_secret) values(secret_name,value) returning id';
      create function vault.update_secret(secret_id uuid,value text) returns void language sql as 'update vault.secrets set decrypted_secret=value where id=secret_id';
      create table cron.job(jobid bigint generated always as identity primary key,jobname text,schedule text,command text);
      create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language sql as 'insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command) returning jobid';
      create function cron.unschedule(job_id bigint) returns void language sql as 'delete from cron.job where jobid=job_id';
      create function net.http_get(url text,headers jsonb,timeout_milliseconds integer) returns bigint language sql as 'insert into public.http_calls(url,headers) values(url,headers) returning id';
    `);
    const sql=(await schedulerSql('https://shop.example.com',secret)).replace(/^create extension[^\n]*\n/gm,'');
    await database.exec(sql); await database.exec(sql);
    assert.equal((await database.query('select * from cron.job')).rows.length,1);
    await database.exec('select public.dispatch_shop_maintenance()');
    const call=(await database.query('select * from public.http_calls')).rows[0];
    assert.equal(call.url,'https://shop.example.com/api/email-retry');
    assert.equal(call.headers.Authorization,'Bearer '+secret);
    await database.exec('set role anon');
    await assert.rejects(database.query('select public.dispatch_shop_maintenance()'));
  }finally{await database.close();}
});
test('scheduler configuration rejects non-public origins and short secrets', async()=>{
  for(const origin of ['http://localhost:3000','https://user:password@shop.example.com','https://shop.example.com/path'])await assert.rejects(schedulerSql(origin,'a'.repeat(64)));
  await assert.rejects(schedulerSql('https://shop.example.com','short'));
});
