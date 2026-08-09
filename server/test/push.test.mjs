/* RFC 8291 Bölüm 5'teki resmi test vektörüyle doğrulama.
   Çalıştırma:  node server/test/push.test.mjs   */

import { encryptPayload, bytesToB64url, b64urlToBytes, vapidHeader, generateVapidKeys } from '../src/push.js';

// RFC 8291 §5
const V = {
  plaintext:  'When I grow up, I want to be a watermelon',
  asPublic:   'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate:  'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:   'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth:       'BTBZMqHH6r4Tts7J_aSIgg',
  salt:       'DGv6ra1nlYgDCS1FRnbzlw',
  shared:     'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm:        'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek:        'oIhVW04MRdy2XN9CiKLxTg',
  nonce:      '4h_95klXJ5E_qnoN',
  header:     'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
};

let fail = 0;
function check(ad, beklenen, bulunan) {
  const ok = beklenen === bulunan;
  if (!ok) fail++;
  console.log((ok ? '  OK   ' : '  HATA ') + ad);
  if (!ok) {
    console.log('        beklenen: ' + beklenen);
    console.log('        bulunan : ' + bulunan);
  }
}

console.log('RFC 8291 test vektörü:');

const { body, debug } = await encryptPayload(V.plaintext, V.uaPublic, V.auth, {
  salt: V.salt, asPublic: V.asPublic, asPrivate: V.asPrivate
});

check('ECDH ortak sırrı', V.shared, bytesToB64url(debug.shared));
check('IKM',              V.ikm,    bytesToB64url(debug.ikm));
check('CEK',              V.cek,    bytesToB64url(debug.cek));
check('Nonce',            V.nonce,  bytesToB64url(debug.nonce));
check('Başlık (86 bayt)', V.header, bytesToB64url(debug.header));

// Şifreli metni kendi anahtarımızla çözüp aynı metni geri alıyor muyuz
const aesKey = await crypto.subtle.importKey('raw', debug.cek, { name: 'AES-GCM' }, false, ['decrypt']);
const cozulen = new Uint8Array(await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: debug.nonce, tagLength: 128 }, aesKey, debug.ciphertext));
const metin = new TextDecoder().decode(cozulen.slice(0, -1));
check('Şifre çözme (gidiş-dönüş)', V.plaintext, metin);
check('Son kayıt işareti 0x02', '2', String(cozulen[cozulen.length - 1]));
check('Gövde uzunluğu (86 + şifreli)', String(86 + debug.ciphertext.length), String(body.length));

console.log('\nVAPID başlığı:');
const keys = await generateVapidKeys();
const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys.publicKey, keys.privateKey, 'mailto:test@example.com');
const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
check('Başlık biçimi', 'true', String(!!m));
if (m) {
  const hdr = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1])));
  const pl  = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[2])));
  check('JWT alg', 'ES256', hdr.alg);
  check('JWT aud', 'https://fcm.googleapis.com', pl.aud);
  check('JWT sub', 'mailto:test@example.com', pl.sub);
  check('İmza uzunluğu (64 bayt)', '64', String(b64urlToBytes(m[3]).length));
  check('k = açık anahtar', keys.publicKey, m[4]);

  // İmzayı gerçekten doğrula
  const pub = b64urlToBytes(keys.publicKey);
  const vk = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65))
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const gecerli = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk,
    b64urlToBytes(m[3]), new TextEncoder().encode(m[1] + '.' + m[2]));
  check('İmza doğrulaması', 'true', String(gecerli));
}

console.log('\nKirli girdiye dayanıklılık:');
// Ortam değişkenine bulaşan satır sonu / boşluk / padding sorun çıkarmamalı
const temizBekleniyor = bytesToB64url(b64urlToBytes(V.auth));
check('sondaki \\r\\n yok sayılıyor', temizBekleniyor, bytesToB64url(b64urlToBytes(V.auth + '\r\n')));
check('baştaki boşluk yok sayılıyor', temizBekleniyor, bytesToB64url(b64urlToBytes('  ' + V.auth)));
check('padding\'li girdi kabul ediliyor', temizBekleniyor, bytesToB64url(b64urlToBytes(V.auth + '==')));
check('standart base64 (+/) kabul ediliyor',
  bytesToB64url(b64urlToBytes('a-b_')), bytesToB64url(b64urlToBytes('a+b/')));

let hataAlindiUzunluk = '';
try { b64urlToBytes('abcde'); } catch (e) { hataAlindiUzunluk = 'evet'; }
check('geçersiz uzunlukta anlamlı hata', 'evet', hataAlindiUzunluk);

let hataAlindi = '';
try { b64urlToBytes('geçersiz!karakter'); } catch (e) { hataAlindi = 'evet'; }
check('geçersiz karakterde anlamlı hata', 'evet', hataAlindi);
hataAlindi = '';
try { b64urlToBytes('   '); } catch (e) { hataAlindi = 'evet'; }
check('boş değerde anlamlı hata', 'evet', hataAlindi);

// Satır sonu bulaşmış gizli anahtarla VAPID başlığı yine üretilebilmeli
const k2 = await generateVapidKeys();
let vapidOk = 'hayır';
try {
  await vapidHeader('https://fcm.googleapis.com/fcm/send/x', k2.publicKey, k2.privateKey + '\n', 'mailto:a@b.c');
  vapidOk = 'evet';
} catch (e) { vapidOk = 'hata: ' + e.message; }
check('satır sonlu gizli anahtarla VAPID', 'evet', vapidOk);

console.log(fail === 0 ? '\nTÜM TESTLER GEÇTİ' : '\n' + fail + ' TEST BAŞARISIZ');
process.exit(fail === 0 ? 0 : 1);
