/* VAPID anahtar çifti üretir (kurulumda bir kez).
   Çalıştırma:  node server/tools/generate-vapid.mjs   */

import { generateVapidKeys } from '../src/push.js';

const k = await generateVapidKeys();
console.log('VAPID_PUBLIC_KEY  = ' + k.publicKey);
console.log('VAPID_PRIVATE_KEY = ' + k.privateKey);
console.log('');
console.log('Açık anahtar uygulamaya ve wrangler.toml içine, gizli anahtar');
console.log('"npx wrangler secret put VAPID_PRIVATE_KEY" komutuna verilecek.');
console.log('Gizli anahtarı depoya (git) KOYMAYIN.');
