/* Cron karar mantığı testi: doğru dakikada, bir kez, doğru içerikle gönderiyor mu?
   Gerçek push servisine gitmez; fetch taklit edilir ama şifreleme gerçekten çalışır.
   Çalıştırma:  node server/test/schedule.test.mjs   */

import { cihaziIsle, yerelZaman } from '../src/index.js';
import { generateVapidKeys } from '../src/push.js';

let fail = 0;
function check(ad, beklenen, bulunan) {
  const ok = String(beklenen) === String(bulunan);
  if (!ok) fail++;
  console.log((ok ? '  OK   ' : '  HATA ') + ad);
  if (!ok) console.log('        beklenen: ' + beklenen + '\n        bulunan : ' + bulunan);
}

/* --- sahte KV --- */
function sahteKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, tip) { const v = m.get(k); return v === undefined ? null : (tip === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
  };
}

/* --- sahte fetch: push isteklerini yakala --- */
const gonderilenler = [];
globalThis.fetch = async (url, opts) => {
  gonderilenler.push({ url: String(url), headers: opts.headers, length: opts.body.length });
  return new Response(null, { status: 201 });
};

const vapid = await generateVapidKeys();
const env = {
  DEVICES: sahteKV(),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.com',
  PUBLIC_API_URL: 'https://ornek.workers.dev'
};

const dev = {
  subscription: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/TEST',
    keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg'
    }
  },
  tz: 'Europe/Istanbul',
  meds: [{ name: 'Aspirin', note: '1 tablet', times: ['08:00', '20:00'] }],
  snoozes: []
};

/* Europe/Istanbul = UTC+3 → 05:00Z = yerel 08:00 */
const saat0800 = new Date('2026-08-10T05:00:30Z');

console.log('Zaman dilimi:');
const y = yerelZaman('Europe/Istanbul', saat0800);
check('yerel tarih', '2026-08-10', y.tarih);
check('yerel saat', '08:00', y.hhmm);
check('yaz saati yok, sabit +03', 480, y.dakika);

console.log('\nPlanlı bildirim:');
await cihaziIsle(env, 'cihaz1', dev, saat0800);
check('bir bildirim gönderildi', 1, gonderilenler.length);
check('doğru uç nokta', dev.subscription.endpoint, gonderilenler[0] && gonderilenler[0].url);
check('aes128gcm başlığı', 'aes128gcm', gonderilenler[0] && gonderilenler[0].headers['Content-Encoding']);
check('VAPID yetkilendirme', 'true', String(!!(gonderilenler[0] && gonderilenler[0].headers.Authorization.startsWith('vapid t='))));
check('şifreli gövde 86 bayttan uzun', 'true', String(gonderilenler[0].length > 86));

console.log('\nAynı dakikada ikinci tarama (tekrar göndermemeli):');
await cihaziIsle(env, 'cihaz1', dev, new Date('2026-08-10T05:00:59Z'));
check('hâlâ tek bildirim', 1, gonderilenler.length);

console.log('\nCron 3 dakika gecikirse telafi etmeli:');
env.DEVICES._m.clear();
gonderilenler.length = 0;
await cihaziIsle(env, 'cihaz1', dev, new Date('2026-08-10T05:03:00Z'));
check('gecikmiş tarama gönderdi', 1, gonderilenler.length);

console.log('\n10 dakika gecikirse artık göndermemeli (çok geç):');
env.DEVICES._m.clear();
gonderilenler.length = 0;
await cihaziIsle(env, 'cihaz1', dev, new Date('2026-08-10T05:10:00Z'));
check('çok geç, gönderilmedi', 0, gonderilenler.length);

console.log('\nSaati gelmeyen ilaç:');
gonderilenler.length = 0;
await cihaziIsle(env, 'cihaz1', dev, new Date('2026-08-10T04:30:00Z'));
check('erken, gönderilmedi', 0, gonderilenler.length);

console.log('\nErtelenmiş bildirim:');
env.DEVICES._m.clear();
gonderilenler.length = 0;
const devErtelemeli = JSON.parse(JSON.stringify(dev));
devErtelemeli.meds = [];
devErtelemeli.snoozes = [
  { at: '2026-08-10T05:00:00Z', name: 'Aspirin', note: '1 tablet', time: '08:00' },  // vakti geldi
  { at: '2026-08-10T09:00:00Z', name: 'Tansiyon', note: '', time: '12:00' }          // henüz değil
];
await env.DEVICES.put('dev:cihaz1', JSON.stringify(devErtelemeli));
await cihaziIsle(env, 'cihaz1', devErtelemeli, saat0800);
check('vakti gelen erteleme gönderildi', 1, gonderilenler.length);
const kalan = JSON.parse(await env.DEVICES.get('dev:cihaz1')).snoozes;
check('gönderilen erteleme listeden düştü', 1, kalan.length);
check('kalan erteleme doğru', 'Tansiyon', kalan[0].name);

console.log('\nİki farklı saat, iki ayrı bildirim:');
env.DEVICES._m.clear();
gonderilenler.length = 0;
await cihaziIsle(env, 'cihaz1', dev, saat0800);
await cihaziIsle(env, 'cihaz1', dev, new Date('2026-08-10T17:00:20Z'));  // yerel 20:00
check('gün içinde iki bildirim', 2, gonderilenler.length);

console.log('\nFarklı zaman dilimi (Europe/London, UTC+1 yaz saati):');
env.DEVICES._m.clear();
gonderilenler.length = 0;
const devLondra = Object.assign({}, dev, { tz: 'Europe/London' });
await cihaziIsle(env, 'cihaz2', devLondra, new Date('2026-08-10T07:00:10Z'));  // Londra 08:00
check('Londra 08:00 gönderdi', 1, gonderilenler.length);

console.log(fail === 0 ? '\nTÜM TESTLER GEÇTİ' : '\n' + fail + ' TEST BAŞARISIZ');
process.exit(fail === 0 ? 0 : 1);
