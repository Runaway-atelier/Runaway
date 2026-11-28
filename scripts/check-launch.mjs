import { existsSync } from 'node:fs';
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const live=process.argv.includes('--live');
const checks=[];
const check=(name,ok)=>{checks.push(ok);console.log(`${ok?'OK':'FAIL'} ${name}`);};
const env=process.env;
check(live?'Live Paystack secret':'Test Paystack secret',!!env.PAYSTACK_SECRET_KEY?.startsWith(live?'sk_live_':'sk_test_'));
check('Live charging switch',live?env.PAYSTACK_LIVE_ENABLED==='true':env.PAYSTACK_LIVE_ENABLED!=='true');
check('Dedicated owner passcode',!!env.ADMIN_SECRET_KEY&&env.ADMIN_SECRET_KEY.length>=32);
check('Cron secret',!!env.CRON_SECRET&&env.CRON_SECRET.length>=32);
check('Database settings',!!env.SUPABASE_URL?.startsWith('https://')&&!!env.SUPABASE_SERVICE_ROLE_KEY);
check('Resend key',!!env.RESEND_API_KEY?.startsWith('re_'));
check('Sender domain configured',!!env.RESEND_FROM_EMAIL&&!/example\.com|yourdomain\.com|resend\.dev/.test(env.RESEND_FROM_EMAIL));
check('Shop notification inbox',/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ORDER_NOTIFICATION_EMAIL||''));
check('Paystack webhook validation',!!env.PAYSTACK_WEBHOOK_SECRET?.startsWith('whsec_')||env.PAYSTACK_ALLOW_LEGACY_WEBHOOKS==='true');
check('Resend webhook signing secret',!!env.RESEND_WEBHOOK_SECRET?.startsWith('whsec_'));
const argument=process.argv.find(a=>a.startsWith('--origin='));
if(argument){
  const origin=new URL(argument.slice(9));
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Supply a public HTTPS origin.');
  const paths=[['/collection',200],['/api/shop',200],['/api/admin-orders',401],['/.env.local',404],['/lib/admin.mjs',404],['/scratch/resend-test.json',404],['/supabase/migrations/20261123_payments.sql',404],['/api/email-retry',401]];
  const results=await Promise.all(paths.map(async([path,status])=>{
    try{
      const response=await fetch(origin.origin+path,{redirect:'manual',signal:AbortSignal.timeout(15000)});
      let ok=response.status===status;
      if(path==='/api/shop'&&ok){const shop=await response.json();ok=Array.isArray(shop.products)&&shop.products.length>0&&shop.environment===(live?'live':'test');}
      if(path==='/collection'&&ok)ok=response.headers.get('x-content-type-options')==='nosniff';
      return [path,ok];
    }catch{return[path,false];}
  }));
  for(const [path,ok]of results)check(`Public ${path}`,ok);
}else console.log('Public deployment checks were not run. Add --origin=https://YOUR_PUBLIC_HOST after deployment.');
console.log('Provider-delivered webhooks, scheduled HTTP responses, browser checkout and inbox delivery require their own end-to-end checks.');
if(checks.some(ok=>!ok))process.exitCode=1;
