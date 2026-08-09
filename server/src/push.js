/* Web Push gönderimi — RFC 8291 (aes128gcm) + RFC 8292 (VAPID)
   Yalnızca WebCrypto kullanır: Cloudflare Workers ve Node 18+ ile çalışır.
   Harici bağımlılık yok. */

const enc = new TextEncoder();

/* ---------------- base64url ---------------- */

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ---------------- HKDF (SHA-256) ---------------- */

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** RFC 5869; length en fazla 32 bayt (tek turluk expand yeterli) */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const t1 = await hmac(prk, concat(info, new Uint8Array([1])));
  return t1.slice(0, length);
}

/* ---------------- Anahtarlar ---------------- */

/** Ham (uncompressed, 65 bayt) açık anahtarı + 32 baytlık d'yi JWK'ya çevirir */
function toJwk(publicBytes, privateBytes) {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(publicBytes.slice(1, 33)),
    y: bytesToB64url(publicBytes.slice(33, 65)),
    ext: true
  };
  if (privateBytes) jwk.d = bytesToB64url(privateBytes);
  return jwk;
}

async function importEcdhPrivate(publicBytes, privateBytes) {
  return crypto.subtle.importKey('jwk', toJwk(publicBytes, privateBytes),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function importEcdhPublic(publicBytes) {
  return crypto.subtle.importKey('raw', publicBytes,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** VAPID için yeni bir anahtar çifti üretir (kurulumda bir kez çalıştırılır) */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: bytesToB64url(pub), privateKey: jwk.d };
}

/* ---------------- Yük şifreleme (RFC 8291) ---------------- */

/**
 * @param {string} payload        Gönderilecek metin (JSON)
 * @param {string} uaPublicB64    Aboneliğin p256dh değeri
 * @param {string} authB64        Aboneliğin auth değeri
 * @param {object} [fixed]        Test vektörü için sabit salt/anahtar
 */
export async function encryptPayload(payload, uaPublicB64, authB64, fixed) {
  const uaPublic = b64urlToBytes(uaPublicB64);
  const authSecret = b64urlToBytes(authB64);

  let asPublic, asPrivateKey;
  if (fixed) {
    asPublic = b64urlToBytes(fixed.asPublic);
    asPrivateKey = await importEcdhPrivate(asPublic, b64urlToBytes(fixed.asPrivate));
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivateKey = pair.privateKey;
  }

  const salt = fixed ? b64urlToBytes(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));

  // 1) ECDH ortak sırrı
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importEcdhPublic(uaPublic) }, asPrivateKey, 256));

  // 2) IKM = HKDF(auth_secret, shared, "WebPush: info" || 0x00 || ua_public || as_public)
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // 3) CEK ve nonce
  const cek   = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'),      new Uint8Array([0])), 12);

  // 4) AES-128-GCM ile şifrele (son kayıt işareti: 0x02)
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

  // 5) Başlık: salt(16) || rs(4) || idlen(1) || as_public(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);

  return {
    body: concat(header, ciphertext),
    debug: { ikm, cek, nonce, salt, asPublic, header, ciphertext, shared }
  };
}

/* ---------------- VAPID başlığı (RFC 8292) ---------------- */

export async function vapidHeader(endpoint, publicKeyB64, privateKeyB64, subject) {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  };
  const signingInput = bytesToB64url(enc.encode(JSON.stringify(header))) + '.' +
                       bytesToB64url(enc.encode(JSON.stringify(claims)));

  const pub = b64urlToBytes(publicKeyB64);
  const key = await crypto.subtle.importKey('jwk',
    Object.assign(toJwk(pub, b64urlToBytes(privateKeyB64)), { key_ops: ['sign'] }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));

  const jwt = signingInput + '.' + bytesToB64url(sig);
  return 'vapid t=' + jwt + ', k=' + publicKeyB64;
}

/* ---------------- Gönderim ---------------- */

/**
 * Tek bir aboneliğe bildirim gönderir.
 * @returns {Promise<{ok:boolean, status:number, gone:boolean}>}
 */
export async function sendPush(subscription, payloadObj, vapid) {
  const { body } = await encryptPayload(JSON.stringify(payloadObj),
    subscription.keys.p256dh, subscription.keys.auth);

  const auth = await vapidHeader(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '3600',
      'Urgency': 'high'
    },
    body: body
  });

  // 404/410: abonelik iptal edilmiş, kaydı silmeliyiz
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
