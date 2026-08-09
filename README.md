# İlaç Hatırlatıcı

Yaşlı/orta yaş kullanıcı için sade, büyük yazılı bir ilaç hatırlatma PWA'sı.
Backend yok; tüm veriler cihazın `localStorage`'ında saklanır.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `index.html` | Arayüz iskeleti (Bugün / İlaçlar / Takvim sekmeleri, formlar, diyaloglar) |
| `styles.css` | Büyük yazı, büyük buton (min. 56px), yüksek kontrast |
| `app.js` | Veri modeli, zamanlayıcı, bildirim tetikleme, takvim, istatistik, yedekleme |
| `service-worker.js` | Çevrimdışı önbellek + aksiyon butonlu bildirim + tıklama işleme |
| `manifest.json` | "Ana Ekrana Ekle" ile kurulabilmesi için PWA tanımı |
| `icons/` | Uygulama simgeleri (`tools/make-icons.js` ile üretiliyor) |

## Yerelde çalıştırma

```bash
python -m http.server 5173
```

Ardından tarayıcıda `http://localhost:5173` adresini açın.
(Service Worker ve bildirimler yalnızca `localhost` veya HTTPS üzerinde çalışır.)

Simgeleri yeniden üretmek için:

```bash
node tools/make-icons.js
```

## Özellikler

- **İlaç ekleme/düzenleme/silme** — ad (zorunlu), doz/not, kutudaki adet, sınırsız alım saati.
  Her saat satırı tek tek silinebilir; en az bir saat girilmeden kayıt yapılamaz.
  Silme işlemi onay ister.
- **Bildirim** — saat gelince `service-worker.js` üzerinden üç butonlu bildirim:
  **Tamam**, **15 dk Ertele**, **30 dk Ertele**. Bildirimle birlikte titreşim ve kısa uyarı sesi.
- **Bugün ekranı** — "Sıradaki İlaç" kartı (kalan süre ile), günün listesi, "Aldım" / "15 dk Ertele" butonları.
- **Takvim** — aylık görünüm, gün başına ✅ alındı / ❌ kaçırıldı / ⏳ bekliyor işaretleri.
  Güne dokununca o günün detayı açılır. Geçmiş kayıtlar **değiştirilemez**.
- **Otomatik kaçırıldı** — saatinden 3 saat sonra hâlâ işaretlenmemiş doz `kacirildi` olur.
- **Stok takibi** — her "Aldım" onayında adet 1 azalır; 5 ve altına inince uyarı şeridi çıkar.
- **Uyum oranı** — son 7 gün ve son 30 gün için yüzde.
- **Yedekleme** — verileri JSON olarak indirme ve geri yükleme.

## Veri şeması (localStorage anahtarı: `ilacTakip.v1`)

```json
{
  "medications": [{
    "id": "uuid", "name": "Aspirin", "dosageNote": "1 tablet, aç karnına",
    "times": [{ "id": "uuid", "time": "08:00" }],
    "stockCount": 30, "active": true, "createdAt": "ISO"
  }],
  "logs": [{
    "id": "uuid", "medicationId": "uuid", "timeId": "uuid",
    "scheduledDate": "2026-08-09", "scheduledTime": "08:00",
    "status": "alindi | kacirildi | bekliyor",
    "takenAt": "ISO | null", "snoozeCount": 0,
    "snoozeUntil": "ISO | null", "notifiedFor": 0
  }],
  "settings": { "lastEnsuredDate": "2026-08-09", "notifAsked": true }
}
```

## Sunucu (Faz 3 — Web Push)

`server/` altındaki Cloudflare Worker, bildirimleri **telefon yerine sunucunun** göndermesini
sağlar; böylece uygulama tamamen kapalıyken de hatırlatma gelir.

- `server/src/push.js` — RFC 8291 (aes128gcm) ve RFC 8292 (VAPID) uygulaması.
  Harici bağımlılık yok, yalnızca WebCrypto. RFC 8291 §5 test vektörüyle doğrulanıyor.
- `server/src/index.js` — HTTP uçları ve dakikalık cron taraması.
- Veriler Cloudflare KV'de: abonelik, zaman dilimi, ilaç adları/saatleri, erteleme kuyruğu.

Testler:

```bash
cd server && npm test
```

Dağıtım:

```bash
cd server && npx wrangler deploy
```

Uygulamanın sunucuyu kullanması için `config.js` içindeki `pushApi` Worker adresine
ayarlanır. Boş bırakılırsa uygulama eski davranışına döner (bildirimleri telefon zamanlar).

Gizli VAPID anahtarı depoda tutulmaz; `npx wrangler secret put VAPID_PRIVATE_KEY`
ile yalnızca Cloudflare'de saklanır.

## Bilinen teknik kısıtlamalar

- **Backend olmadığı için** bildirimlerin tetiklenmesi, uygulamanın (tarayıcı sekmesi veya PWA)
  en azından arka planda açık olmasına bağlıdır. "Tamamen kapalıyken bile garanti bildirim"
  senaryosu Web Push API + sunucu (VAPID) gerektirir — Faz 3.
- **iPhone/iOS**: bildirimler yalnızca iOS 16.4+ ve uygulama "Ana Ekrana Ekle" ile
  kurulduğunda çalışır. Arka plan güvenilirliği Android'e göre daha düşüktür.
- Uygulama kapalıyken bildirimden "Ertele" seçilirse, işlem IndexedDB kuyruğuna yazılır ve
  uygulama bir sonraki açılışta uygulanır.
- Veriler tek cihazda tutulur. Tarayıcı verileri temizlenirse kayıtlar silinir —
  ara sıra "Yedeği İndir" ile yedek alın.
