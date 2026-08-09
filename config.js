/* Sunucu ayarı.
   pushApi boş bırakılırsa uygulama eskisi gibi çalışır: bildirimleri
   telefonun kendisi zamanlar (uygulama kapalıyken gelmeyebilir).
   Cloudflare Worker adresi girilirse bildirimleri sunucu gönderir. */

window.ILAC_CONFIG = {
  pushApi: 'https://ilac-hatirlatici.esmaguven2206.workers.dev'
};
