import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function schedulerSql(origin,secret){
const target=new URL(origin);
if(target.protocol!=='https:'||target.username||target.password||target.pathname!=='/'||target.search||target.hash||target.hostname==='localhost'||target.hostname==='127.0.0.1')throw new Error('Supply the public HTTPS origin only.');
if(!secret||secret.length<32)throw new Error('CRON_SECRET must contain at least 32 characters.');
const quote=value=>value.replaceAll("'","''");
const template=await readFile(new URL('../supabase/schedule-maintenance.sql',import.meta.url),'utf8');
return template.replaceAll('__RUNAWAY_PUBLIC_ORIGIN__',quote(target.origin)).replaceAll('__RUNAWAY_CRON_SECRET__',quote(secret));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
if(!process.argv[2])throw new Error('Usage: npm run prepare:scheduler -- https://YOUR_PUBLIC_HOST');
const sql=await schedulerSql(process.argv[2],process.env.CRON_SECRET);
await mkdir('scratch',{recursive:true});
await writeFile('scratch/supabase-scheduler.sql',sql);
console.log('Prepared scratch/supabase-scheduler.sql for your Supabase SQL Editor. This private file contains the cron secret; keep it out of source control.');
}
