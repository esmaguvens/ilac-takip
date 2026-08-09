/* İlaç Hatırlatıcı — Cloudflare Worker
   - Dakikada bir çalışır (cron), vakti gelen ilaçlar için Web Push gönderir
   - Uygulama tamamen kapalı olsa bile bildirim ulaşır
   KV: DEVICES
     dev:{deviceId}                       -> { subscription, tz, meds, snoozes, updatedAt }
     sent:{deviceId}:{tarih}:{etiket}     -> "1" (aynı bildirim iki kez gitmesin, 25 saat TTL)
*/

import { sendPush } from './push.js';

const GECIKME_TOLERANSI_DK = 5;   // cron gecikirse kaç dakikaya kadar telafi edilsin

/* ---------------- HTTP ---------------- */

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(origin))
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      if (url.pathname === '/api/key' && request.method === 'GET') {
        return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, origin);
      }

      if (url.pathname === '/api/health') {
        return json({ ok: true, time: new Date().toISOString() }, 200, origin);
      }

      if (url.pathname === '/api/register' && request.method === 'POST') {
        const body = await request.json();
        if (!body.deviceId || !body.subscription || !body.subscription.endpoint) {
          return json({ error: 'deviceId ve subscription gerekli' }, 400, origin);
        }
        const key = 'dev:' + body.deviceId;
        const eski = await env.DEVICES.get(key, 'json');
        await env.DEVICES.put(key, JSON.stringify({
          subscription: body.subscription,
          tz: body.tz || 'Europe/Istanbul',
          meds: Array.isArray(body.meds) ? body.meds : [],
          snoozes: (eski && eski.snoozes) || [],
          updatedAt: new Date().toISOString()
        }));
        return json({ ok: true, medCount: (body.meds || []).length }, 200, origin);
      }

      if (url.pathname === '/api/snooze' && request.method === 'POST') {
        const body = await request.json();
        const key = 'dev:' + body.deviceId;
        const dev = await env.DEVICES.get(key, 'json');
        if (!dev) return json({ error: 'cihaz bulunamadı' }, 404, origin);

        dev.snoozes = (dev.snoozes || []).filter((s) => new Date(s.at) > new Date());
        dev.snoozes.push({
          at: new Date(Date.now() + (Number(body.minutes) || 15) * 60000).toISOString(),
          name: body.name || 'İlaç',
          note: body.note || '',
          time: body.time || ''
        });
        await env.DEVICES.put(key, JSON.stringify(dev));
        return json({ ok: true, snoozeCount: dev.snoozes.length }, 200, origin);
      }

      if (url.pathname === '/api/unregister' && request.method === 'POST') {
        const body = await request.json();
        await env.DEVICES.delete('dev:' + body.deviceId);
        return json({ ok: true }, 200, origin);
      }

      // Kurulum sonrası "gerçekten çalışıyor mu" testi
      if (url.pathname === '/api/test' && request.method === 'POST') {
        const body = await request.json();
        const dev = await env.DEVICES.get('dev:' + body.deviceId, 'json');
        if (!dev) return json({ error: 'cihaz bulunamadı' }, 404, origin);
        const res = await gonder(env, body.deviceId, dev, {
          title: 'Test bildirimi',
          body: 'Sunucudan gelen bildirimler çalışıyor.',
          logKey: 'test',
          test: true
        });
        return json(res, res.ok ? 200 : 502, origin);
      }

      return json({ error: 'bulunamadı' }, 404, origin);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(taramaYap(env));
  }
};

/* ---------------- Zaman yardımcıları ---------------- */

/** Verilen zaman diliminde tarih ("YYYY-MM-DD") ve dakika (0-1439) döndürür */
export function yerelZaman(tz, date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const saat = p.hour === '24' ? '00' : p.hour;   // bazı ortamlarda 24 dönebiliyor
  return {
    tarih: p.year + '-' + p.month + '-' + p.day,
    dakika: parseInt(saat, 10) * 60 + parseInt(p.minute, 10),
    hhmm: saat + ':' + p.minute
  };
}

/* ---------------- Cron taraması ---------------- */

async function taramaYap(env) {
  const simdi = new Date();
  let cursor;

  do {
    const liste = await env.DEVICES.list({ prefix: 'dev:', cursor: cursor });
    cursor = liste.list_complete ? null : liste.cursor;

    for (const anahtar of liste.keys) {
      const deviceId = anahtar.name.slice(4);
      const dev = await env.DEVICES.get(anahtar.name, 'json');
      if (!dev || !dev.subscription) continue;
      try {
        await cihaziIsle(env, deviceId, dev, simdi);
      } catch (err) {
        console.error('cihaz işlenemedi', deviceId, err);
      }
    }
  } while (cursor);
}

export async function cihaziIsle(env, deviceId, dev, simdi) {
  const yerel = yerelZaman(dev.tz || 'Europe/Istanbul', simdi);

  // 1) Planlı ilaç saatleri
  for (const med of dev.meds || []) {
    for (const saat of med.times || []) {
      const [h, m] = String(saat).split(':').map(Number);
      if (isNaN(h) || isNaN(m)) continue;

      const fark = yerel.dakika - (h * 60 + m);
      // Saati geçmiş ama en fazla birkaç dakika (cron gecikmesi telafisi)
      if (fark < 0 || fark > GECIKME_TOLERANSI_DK) continue;

      const sentKey = 'sent:' + deviceId + ':' + yerel.tarih + ':' + saat;
      if (await env.DEVICES.get(sentKey)) continue;

      await gonder(env, deviceId, dev, {
        title: 'İlaç saati: ' + med.name,
        body: saat + (med.note ? ' — ' + med.note : ' — ilacınızı alma zamanı'),
        logKey: yerel.tarih + '|' + saat + '|' + med.name,
        name: med.name,
        note: med.note || '',
        time: saat
      });
      await env.DEVICES.put(sentKey, '1', { expirationTtl: 90000 });
    }
  }

  // 2) Ertelenmiş bildirimler
  const kalan = [];
  let degisti = false;
  for (const s of dev.snoozes || []) {
    if (new Date(s.at) > simdi) { kalan.push(s); continue; }
    degisti = true;
    await gonder(env, deviceId, dev, {
      title: 'İlaç saati: ' + s.name,
      body: (s.note ? s.note + ' — ' : '') + 'ertelenen hatırlatma',
      logKey: yerel.tarih + '|' + s.time + '|' + s.name,
      name: s.name,
      note: s.note || '',
      time: s.time || yerel.hhmm
    });
  }
  if (degisti) {
    dev.snoozes = kalan;
    await env.DEVICES.put('dev:' + deviceId, JSON.stringify(dev));
  }
}

async function gonder(env, deviceId, dev, payload) {
  const tam = Object.assign({
    deviceId: deviceId,
    api: env.PUBLIC_API_URL || ''
  }, payload);

  const res = await sendPush(dev.subscription, tam, {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com'
  });

  if (res.gone) {
    await env.DEVICES.delete('dev:' + deviceId);
    console.log('abonelik iptal edilmiş, kayıt silindi:', deviceId);
  }
  return res;
}
