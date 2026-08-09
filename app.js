'use strict';

/* =========================================================
   İlaç Hatırlatıcı — uygulama mantığı
   Veri: localStorage (tek cihaz). Bildirim: Service Worker.
   ========================================================= */

const STORAGE_KEY   = 'ilacTakip.v1';
const TICK_MS       = 15000;      // saat kontrol sıklığı
const AUTO_MISS_H   = 3;          // kaç saat sonra "kaçırıldı" sayılsın
const LOW_STOCK     = 5;          // stok uyarı eşiği
const BACKFILL_DAYS = 60;         // geçmişe dönük en fazla kaç gün log üretilsin

const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
               'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const GUNLER_KISA = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];
const GUNLER = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];

/* ---------------------- Durum ---------------------- */

let state = {
  medications: [],
  logs: [],
  settings: { lastEnsuredDate: null, notifAsked: false }
};

let currentView = 'bugun';
let calCursor = new Date();       // takvimde gösterilen ay
let editingMedId = null;
let swReg = null;
let installPrompt = null;         // Android'de "Uygulamayı Yükle" için
let storageOk = true;             // localStorage yazılabiliyor mu
let storageErrName = null;        // yazılamıyorsa hatanın adı

/* ---------------------- Yardımcılar ---------------------- */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date -> "YYYY-MM-DD" (yerel saat) */
function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** "YYYY-MM-DD" -> Date (yerel, gece yarısı) */
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayStr() { return dateStr(new Date()); }

/** Bir logun planlanan zamanı (ms) */
function schedTs(log) {
  const [h, mi] = log.scheduledTime.split(':').map(Number);
  const d = parseDate(log.scheduledDate);
  d.setHours(h, mi, 0, 0);
  return d.getTime();
}

/** Erteleme dikkate alınarak bildirimin/işaretlemenin geçerli zamanı */
function dueTs(log) {
  const base = schedTs(log);
  if (log.snoozeUntil) {
    const s = new Date(log.snoozeUntil).getTime();
    if (!isNaN(s) && s > base) return s;
  }
  return base;
}

function humanDate(s) {
  const d = parseDate(s);
  return d.getDate() + ' ' + AYLAR[d.getMonth()] + ' ' + d.getFullYear() + ', ' + GUNLER[d.getDay()];
}

function medById(id) { return state.medications.find((m) => m.id === id); }
function logById(id) { return state.logs.find((l) => l.id === id); }

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------------- Kalıcı saklama ---------------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.medications = Array.isArray(parsed.medications) ? parsed.medications : [];
      state.logs        = Array.isArray(parsed.logs) ? parsed.logs : [];
      state.settings    = Object.assign(state.settings, parsed.settings || {});
    }
  } catch (err) {
    console.error('Veri okunamadı:', err);
    toast('Kayıtlı veriler okunamadı.');
  }
}

/** localStorage gerçekten yazılabiliyor mu? */
function checkStorage() {
  try {
    localStorage.setItem('__ilac_test__', '1');
    localStorage.removeItem('__ilac_test__');
    storageOk = true;
    storageErrName = null;
  } catch (err) {
    storageOk = false;
    storageErrName = (err && err.name) || 'Bilinmeyen hata';
    console.error('Depolama kullanılamıyor:', err);
  }
  return storageOk;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (!storageOk) { storageOk = true; storageErrName = null; renderBanners(); }
  } catch (err) {
    console.error('Veri kaydedilemedi:', err);
    storageOk = false;
    storageErrName = (err && err.name) || 'Bilinmeyen hata';
    const dolu = err && (err.name === 'QuotaExceededError' || err.code === 22);
    toast(dolu
      ? 'Kaydedilemedi: tarayıcının bu site için ayırdığı alan dolu.'
      : 'Kaydedilemedi: tarayıcı bu site için veri saklamayı engelliyor.', 6000);
    renderBanners();
  }
}

/* ---------------------- Log üretimi ---------------------- */

/** Belirli bir gün için eksik log kayıtlarını oluşturur. */
function ensureLogsForDate(ds) {
  const dayStart = parseDate(ds).getTime();
  let added = false;

  state.medications.forEach((med) => {
    if (!med.active) return;
    // İlaç eklenmeden önceki günler için log üretme
    const created = new Date(med.createdAt);
    if (!isNaN(created) && dateStr(created) > ds) return;

    med.times.forEach((t) => {
      const exists = state.logs.some(
        (l) => l.medicationId === med.id && l.timeId === t.id && l.scheduledDate === ds
      );
      if (exists) return;
      state.logs.push({
        id: uid(),
        medicationId: med.id,
        timeId: t.id,
        scheduledDate: ds,
        scheduledTime: t.time,
        status: 'bekliyor',
        takenAt: null,
        snoozeCount: 0,
        snoozeUntil: null,
        notifiedFor: null
      });
      added = true;
    });
  });

  void dayStart;
  return added;
}

/** Son açılıştan bugüne kadarki günlerin loglarını tamamlar. */
function backfillLogs() {
  const today = todayStr();
  let start = state.settings.lastEnsuredDate;

  if (!start) {
    start = today;
  } else if (start > today) {
    start = today;   // cihaz saati geriye alınmışsa
  }

  const limit = new Date();
  limit.setDate(limit.getDate() - BACKFILL_DAYS);
  if (parseDate(start) < limit) start = dateStr(limit);

  const cursor = parseDate(start);
  const end = parseDate(today);
  while (cursor <= end) {
    ensureLogsForDate(dateStr(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  state.settings.lastEnsuredDate = today;
}

/** Süresi geçmiş "bekliyor" kayıtlarını "kaçırıldı" yapar. */
function autoMarkMissed() {
  const now = Date.now();
  let changed = false;
  state.logs.forEach((l) => {
    if (l.status !== 'bekliyor') return;
    if (now > dueTs(l) + AUTO_MISS_H * 3600 * 1000) {
      l.status = 'kacirildi';
      changed = true;
    }
  });
  return changed;
}

/* ---------------------- Bildirimler ---------------------- */

function notifPermission() {
  return ('Notification' in window) ? Notification.permission : 'unsupported';
}

async function askNotificationPermission() {
  if (!('Notification' in window)) {
    toast('Bu tarayıcı bildirimleri desteklemiyor.');
    return;
  }
  try {
    const res = await Notification.requestPermission();
    if (res === 'granted') toast('Bildirimler açıldı.');
    else toast('Bildirim izni verilmedi.');
  } catch (err) {
    console.error(err);
  }
  renderBanners();
}

/** Bir log için bildirim gösterir (3 aksiyon butonlu). */
function showLogNotification(log) {
  const med = medById(log.medicationId);
  if (!med) return;
  if (notifPermission() !== 'granted') return;

  const payload = {
    logId: log.id,
    title: 'İlaç saati: ' + med.name,
    body: log.scheduledTime + (med.dosageNote ? ' — ' + med.dosageNote : ' — ilacınızı alma zamanı'),
    tag: 'ilac-' + log.id
  };

  if (swReg && swReg.active) {
    swReg.active.postMessage({ type: 'show-notification', payload });
  } else if (swReg) {
    // Service worker henüz aktif değilse doğrudan registration üzerinden göster
    swReg.showNotification(payload.title, {
      body: payload.body, tag: payload.tag, icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png', requireInteraction: true,
      vibrate: [300, 150, 300], data: { logId: log.id },
      actions: [
        { action: 'confirm',  title: 'Tamam' },
        { action: 'snooze15', title: '15 dk Ertele' },
        { action: 'snooze30', title: '30 dk Ertele' }
      ]
    }).catch((e) => console.error(e));
  } else {
    try { new Notification(payload.title, { body: payload.body, tag: payload.tag }); }
    catch (e) { console.error(e); }
  }

  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  beep();
}

/** Kısa uyarı sesi (harici dosya gerektirmez). */
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = beep._ctx || (beep._ctx = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [0, 0.35].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  } catch (err) { /* ses zorunlu değil */ }
}

/* ---------------------- Aksiyonlar ---------------------- */

function markTaken(logId, at) {
  const log = logById(logId);
  if (!log || log.status === 'alindi') return;
  log.status = 'alindi';
  log.takenAt = new Date(at || Date.now()).toISOString();
  log.snoozeUntil = null;

  const med = medById(log.medicationId);
  let stockMsg = '';
  if (med && typeof med.stockCount === 'number' && med.stockCount > 0) {
    med.stockCount -= 1;
    if (med.stockCount === 0) stockMsg = ' ' + med.name + ' bitti, eczaneden almayı unutmayın!';
    else if (med.stockCount <= LOW_STOCK) stockMsg = ' ' + med.stockCount + ' adet kaldı, eczaneden almayı unutmayın.';
  }

  save();
  render();
  toast('Alındı olarak işaretlendi.' + stockMsg, stockMsg ? 6000 : 3000);
  closeNotificationFor(logId);
}

function snoozeLog(logId, minutes, fromTs) {
  const log = logById(logId);
  if (!log || log.status !== 'bekliyor') return;
  const base = fromTs || Date.now();
  log.snoozeUntil = new Date(base + minutes * 60000).toISOString();
  log.snoozeCount = (log.snoozeCount || 0) + 1;
  log.notifiedFor = null;
  save();
  render();
  const t = new Date(log.snoozeUntil);
  toast(minutes + ' dakika ertelendi. Yeni saat: ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()));
  closeNotificationFor(logId);
}

function closeNotificationFor(logId) {
  if (!swReg || !swReg.getNotifications) return;
  swReg.getNotifications({ tag: 'ilac-' + logId })
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => {});
}

/* ---------------------- Zamanlayıcı ---------------------- */

function tick() {
  // Gün değiştiyse yeni günün loglarını üret
  if (state.settings.lastEnsuredDate !== todayStr()) backfillLogs();

  const now = Date.now();
  let changed = autoMarkMissed();

  state.logs.forEach((log) => {
    if (log.status !== 'bekliyor') return;
    const due = dueTs(log);
    if (now < due) return;
    if (now > due + AUTO_MISS_H * 3600 * 1000) return;   // çok geçmiş, kaçırıldı sayılacak
    if (log.notifiedFor === due) return;                 // bu zaman için zaten bildirim gönderildi
    log.notifiedFor = due;
    changed = true;
    showLogNotification(log);
  });

  if (changed) save();
  updateClock();
  render();
}

function updateClock() {
  const d = new Date();
  $('#clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ---------------------- Ekran: uyarı şeritleri ---------------------- */

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
         window.navigator.standalone === true;
}

function renderBanners() {
  const box = $('#banners');
  box.innerHTML = '';

  // Depolama çalışmıyorsa her şeyden önce bunu söyle
  if (!storageOk) {
    box.appendChild(banner('warn',
      '<b>Kayıtlar saklanamıyor.</b><br>' +
      'Tarayıcı bu site için veri saklamaya izin vermiyor, bu yüzden eklediğiniz ilaçlar ' +
      'uygulamayı kapatınca kaybolur.<br><br>' +
      'Sırasıyla deneyin:<br>' +
      '1. Gizli sekmeyi kapatın, normal sekmede açın.<br>' +
      '2. Chrome → ⋮ → Ayarlar → Site ayarları → Çerezler → bu siteye izin verin.<br>' +
      '3. Aşağıdaki "Uygulamayı Yükle" ile kurup ana ekrandaki simgeden açın.<br><br>' +
      '<span class="hint">Teknik ayrıntı: ' + storageErrName + '</span>'));
  }

  // Android'de gerçek kurulum (WebAPK) — Chrome sekmesi yerine ayrı uygulama olarak açılır
  if (installPrompt && !isStandalone()) {
    const b = banner('info',
      '<b>Uygulama olarak yükleyin.</b><br>' +
      'Böylece Chrome sekmesi yerine ayrı bir uygulama gibi açılır ve bildirimler daha güvenilir çalışır.');
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = 'Uygulamayı Yükle';
    btn.addEventListener('click', doInstall);
    b.appendChild(btn);
    box.appendChild(b);
  }

  const perm = notifPermission();
  if (perm === 'denied') {
    box.appendChild(banner('warn',
      '<b>Bildirimler kapalı.</b><br>İlaç hatırlatmaları çalışmayacak. ' +
      'Tarayıcı ayarlarından bu site için bildirim iznini açmanız gerekiyor ' +
      '(adres çubuğundaki kilit simgesi → Bildirimler → İzin ver).'));
  } else if (perm === 'default') {
    const b = banner('info', '<b>Hatırlatma alabilmek için bildirim izni gerekli.</b>');
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = 'Bildirimlere İzin Ver';
    btn.addEventListener('click', askNotificationPermission);
    b.appendChild(btn);
    box.appendChild(b);
  } else if (perm === 'unsupported') {
    box.appendChild(banner('warn',
      '<b>Bu tarayıcı bildirimleri desteklemiyor.</b><br>Uygulamayı açık tutarak listeden takip edebilirsiniz.'));
  }

  // Stok uyarıları
  const low = state.medications.filter(
    (m) => m.active && typeof m.stockCount === 'number' && m.stockCount <= LOW_STOCK
  );
  if (low.length) {
    const txt = low.map((m) => m.name + ': ' + m.stockCount + ' adet').join('<br>');
    box.appendChild(banner('warn', '<b>Eczaneden almayı unutmayın</b><br>' + txt));
  }
}

async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  try {
    const res = await installPrompt.userChoice;
    if (res && res.outcome === 'accepted') toast('Uygulama yükleniyor...');
  } catch (err) {
    console.error(err);
  }
  installPrompt = null;
  renderBanners();
}

function banner(kind, html) {
  const el = document.createElement('div');
  el.className = 'banner banner-' + kind;
  el.innerHTML = html;
  return el;
}

/* ---------------------- Ekran: Bugün ---------------------- */

function renderToday() {
  const ds = todayStr();
  $('#today-title').textContent = humanDate(ds);

  const logs = state.logs
    .filter((l) => l.scheduledDate === ds)
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));

  // Sıradaki ilaç kartı
  const now = Date.now();
  const next = logs
    .filter((l) => l.status === 'bekliyor')
    .sort((a, b) => dueTs(a) - dueTs(b))[0];
  const card = $('#next-med');
  if (next) {
    const med = medById(next.medicationId);
    card.hidden = false;
    $('#next-name').textContent = med ? med.name : '';
    const due = dueTs(next);
    const d = new Date(due);
    $('#next-time').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const diff = due - now;
    if (diff > 0) {
      const mins = Math.round(diff / 60000);
      $('#next-countdown').textContent = mins < 60
        ? mins + ' dakika sonra'
        : Math.floor(mins / 60) + ' saat ' + (mins % 60) + ' dakika sonra';
    } else {
      $('#next-countdown').textContent = 'Şimdi alma zamanı!';
    }
  } else {
    card.hidden = true;
  }

  const list = $('#today-list');
  list.innerHTML = '';

  if (!state.medications.length) {
    list.appendChild(emptyBox('Henüz ilaç eklenmedi. Alt taraftaki “İlaçlar” bölümünden ekleyebilirsiniz.'));
    return;
  }
  if (!logs.length) {
    list.appendChild(emptyBox('Bugün için planlanmış ilaç yok.'));
    return;
  }

  logs.forEach((log) => list.appendChild(todayCard(log)));
}

function todayCard(log) {
  const med = medById(log.medicationId);
  const el = document.createElement('div');
  el.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const time = document.createElement('div');
  time.className = 'card-time';
  time.textContent = log.scheduledTime;
  const name = document.createElement('div');
  name.className = 'card-title';
  name.textContent = med ? med.name : 'Silinmiş ilaç';
  head.append(time, name);
  el.appendChild(head);

  if (med && med.dosageNote) {
    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = med.dosageNote;
    el.appendChild(note);
  }

  const status = document.createElement('div');
  status.className = 'status';

  if (log.status === 'alindi') {
    el.classList.add('done');
    status.classList.add('done');
    const t = log.takenAt ? new Date(log.takenAt) : null;
    status.textContent = '✅ Alındı' + (t ? ' (' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ')' : '');
    el.appendChild(status);
  } else if (log.status === 'kacirildi') {
    el.classList.add('missed');
    status.classList.add('missed');
    status.textContent = '❌ Kaçırıldı';
    el.appendChild(status);
    el.appendChild(actionRow(log, true));
  } else {
    const due = dueTs(log);
    if (log.snoozeUntil) {
      el.classList.add('snoozed');
      const d = new Date(due);
      status.classList.add('wait');
      status.textContent = '⏳ ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' saatine ertelendi';
    } else if (Date.now() >= due) {
      status.classList.add('wait');
      status.textContent = '⏳ Alma zamanı geldi';
    } else {
      status.classList.add('wait');
      status.textContent = '⏳ Bekliyor';
    }
    el.appendChild(status);
    el.appendChild(actionRow(log, false));
  }

  return el;
}

function actionRow(log, missedMode) {
  const row = document.createElement('div');
  row.className = 'card-actions';

  const ok = document.createElement('button');
  ok.className = 'btn btn-success';
  ok.textContent = missedMode ? 'Yine de Aldım' : 'Aldım';
  ok.addEventListener('click', () => markTaken(log.id));
  row.appendChild(ok);

  if (!missedMode) {
    const s15 = document.createElement('button');
    s15.className = 'btn btn-secondary';
    s15.textContent = '15 dk Ertele';
    s15.addEventListener('click', () => snoozeLog(log.id, 15));
    row.appendChild(s15);
  }
  return row;
}

function emptyBox(text) {
  const el = document.createElement('div');
  el.className = 'card empty';
  el.textContent = text;
  return el;
}

/* ---------------------- Ekran: İlaçlar ---------------------- */

function renderMeds() {
  const list = $('#med-list');
  list.innerHTML = '';

  if (!state.medications.length) {
    list.appendChild(emptyBox('Henüz ilaç eklenmedi.'));
    return;
  }

  state.medications.forEach((med) => {
    const el = document.createElement('div');
    el.className = 'card';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = med.name;
    el.appendChild(title);

    if (med.dosageNote) {
      const note = document.createElement('div');
      note.className = 'card-note';
      note.textContent = med.dosageNote;
      el.appendChild(note);
    }

    const times = document.createElement('div');
    med.times.forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t.time;
      times.appendChild(chip);
    });
    el.appendChild(times);

    if (typeof med.stockCount === 'number') {
      const stock = document.createElement('div');
      stock.className = med.stockCount <= LOW_STOCK ? 'stock-warn' : 'card-note';
      stock.textContent = 'Kalan: ' + med.stockCount + ' adet';
      el.appendChild(stock);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const edit = document.createElement('button');
    edit.className = 'btn btn-secondary';
    edit.textContent = 'Düzenle';
    edit.addEventListener('click', () => openMedModal(med.id));

    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = 'Sil';
    del.addEventListener('click', async () => {
      const ok = await confirmDialog('“' + med.name + '” silinsin mi?');
      if (!ok) return;
      deleteMed(med.id);
    });

    actions.append(edit, del);
    el.appendChild(actions);
    list.appendChild(el);
  });
}

function deleteMed(id) {
  const med = medById(id);
  state.medications = state.medications.filter((m) => m.id !== id);
  // Gelecekteki/bekleyen kayıtları temizle, geçmiş kayıtlar takvimde kalsın
  state.logs = state.logs.filter(
    (l) => !(l.medicationId === id && l.status === 'bekliyor')
  );
  save();
  render();
  toast((med ? med.name : 'İlaç') + ' silindi.');
}

/* ---------------------- Ekran: Takvim ---------------------- */

function renderCalendar() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  $('#cal-title').textContent = AYLAR[m] + ' ' + y;

  const grid = $('#calendar');
  grid.innerHTML = '';

  GUNLER_KISA.forEach((g) => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = g;
    grid.appendChild(el);
  });

  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;    // hafta pazartesi başlar
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  for (let i = 0; i < offset; i++) {
    const b = document.createElement('div');
    b.className = 'cal-day blank';
    grid.appendChild(b);
  }

  const today = todayStr();

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = y + '-' + pad2(m + 1) + '-' + pad2(day);
    const logs = state.logs.filter((l) => l.scheduledDate === ds);
    const taken   = logs.filter((l) => l.status === 'alindi').length;
    const missed  = logs.filter((l) => l.status === 'kacirildi').length;
    const waiting = logs.filter((l) => l.status === 'bekliyor').length;

    const cell = document.createElement('button');
    cell.className = 'cal-day';
    if (ds === today) cell.classList.add('today');
    if (logs.length && missed > 0) cell.classList.add('has-missed');
    else if (logs.length && taken === logs.length) cell.classList.add('all-done');

    const num = document.createElement('div');
    num.textContent = day;
    cell.appendChild(num);

    const marks = document.createElement('div');
    marks.className = 'marks';
    let txt = '';
    if (taken)   txt += '✅' + (taken > 1 ? taken : '');
    if (missed)  txt += '❌' + (missed > 1 ? missed : '');
    if (waiting) txt += '⏳' + (waiting > 1 ? waiting : '');
    marks.textContent = txt;
    cell.appendChild(marks);

    cell.setAttribute('aria-label', day + ' ' + AYLAR[m] + ': ' +
      taken + ' alındı, ' + missed + ' kaçırıldı, ' + waiting + ' bekliyor');
    cell.addEventListener('click', () => openDayModal(ds));
    grid.appendChild(cell);
  }

  renderStats();
}

function renderStats() {
  const box = $('#stats');
  box.innerHTML = '';
  box.appendChild(statRow('Son 7 gün', adherence(7)));
  box.appendChild(statRow('Son 30 gün', adherence(30)));
}

function adherence(days) {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const fromStr = dateStr(from);
  const today = todayStr();

  const rel = state.logs.filter(
    (l) => l.scheduledDate >= fromStr && l.scheduledDate <= today &&
           (l.status === 'alindi' || l.status === 'kacirildi')
  );
  const taken = rel.filter((l) => l.status === 'alindi').length;
  return { taken: taken, total: rel.length };
}

function statRow(label, data) {
  const el = document.createElement('div');
  el.className = 'stat';
  const l = document.createElement('div');
  l.textContent = label;
  const v = document.createElement('div');
  if (!data.total) {
    v.textContent = 'Veri yok';
  } else {
    const pct = Math.round((data.taken / data.total) * 100);
    v.innerHTML = '<b>%' + pct + '</b> <span class="hint">(' + data.taken + '/' + data.total + ')</span>';
  }
  el.append(l, v);
  return el;
}

function openDayModal(ds) {
  $('#day-modal-title').textContent = humanDate(ds);
  const list = $('#day-list');
  list.innerHTML = '';

  const logs = state.logs
    .filter((l) => l.scheduledDate === ds)
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));

  if (!logs.length) {
    list.appendChild(emptyBox('Bu gün için kayıt yok.'));
  } else {
    logs.forEach((log) => {
      const med = medById(log.medicationId);
      const el = document.createElement('div');
      el.className = 'card';
      if (log.status === 'alindi') el.classList.add('done');
      if (log.status === 'kacirildi') el.classList.add('missed');

      const head = document.createElement('div');
      head.className = 'card-head';
      const time = document.createElement('div');
      time.className = 'card-time';
      time.textContent = log.scheduledTime;
      const name = document.createElement('div');
      name.className = 'card-title';
      name.textContent = med ? med.name : 'Silinmiş ilaç';
      head.append(time, name);
      el.appendChild(head);

      const st = document.createElement('div');
      st.className = 'status ' + (log.status === 'alindi' ? 'done' : log.status === 'kacirildi' ? 'missed' : 'wait');
      if (log.status === 'alindi') {
        const t = log.takenAt ? new Date(log.takenAt) : null;
        st.textContent = '✅ Alındı' + (t ? ' — ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) : '');
      } else if (log.status === 'kacirildi') {
        st.textContent = '❌ Kaçırıldı';
      } else {
        st.textContent = '⏳ Bekliyor';
      }
      el.appendChild(st);

      if (log.snoozeCount) {
        const s = document.createElement('div');
        s.className = 'card-note';
        s.textContent = log.snoozeCount + ' kez ertelendi';
        el.appendChild(s);
      }
      list.appendChild(el);
    });
  }

  $('#day-modal').hidden = false;
}

/* ---------------------- İlaç formu ---------------------- */

function addTimeRow(value) {
  const row = document.createElement('div');
  row.className = 'time-row';

  const input = document.createElement('input');
  input.type = 'time';
  input.required = true;
  input.step = 60;
  input.value = value || '';
  input.setAttribute('aria-label', 'Alım saati');

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn';
  del.textContent = '✕';
  del.setAttribute('aria-label', 'Bu saati sil');
  del.addEventListener('click', () => {
    row.remove();
    if (!$('#time-rows').children.length) addTimeRow('');
  });

  row.append(input, del);
  $('#time-rows').appendChild(row);
  return input;
}

function openMedModal(medId) {
  editingMedId = medId || null;
  const med = medId ? medById(medId) : null;

  $('#med-modal-title').textContent = med ? 'İlacı Düzenle' : 'Yeni İlaç';
  $('#f-name').value  = med ? med.name : '';
  $('#f-note').value  = med && med.dosageNote ? med.dosageNote : '';
  $('#f-stock').value = med && typeof med.stockCount === 'number' ? med.stockCount : '';
  $('#form-error').hidden = true;
  $('#time-rows').innerHTML = '';

  if (med && med.times.length) med.times.forEach((t) => addTimeRow(t.time));
  else addTimeRow('08:00');

  $('#med-modal').hidden = false;
  setTimeout(() => $('#f-name').focus(), 50);
}

function closeMedModal() {
  $('#med-modal').hidden = true;
  editingMedId = null;
}

function submitMedForm(e) {
  e.preventDefault();
  const err = $('#form-error');
  const name = $('#f-name').value.trim();
  const note = $('#f-note').value.trim();
  const stockRaw = $('#f-stock').value.trim();

  if (!name) {
    err.textContent = 'İlaç adını yazmanız gerekiyor.';
    err.hidden = false;
    $('#f-name').focus();
    return;
  }

  const times = [];
  const seen = new Set();
  $$('#time-rows input[type="time"]').forEach((inp) => {
    const v = inp.value;
    if (v && !seen.has(v)) { seen.add(v); times.push(v); }
  });

  if (!times.length) {
    err.textContent = 'En az bir alım saati girmeniz gerekiyor.';
    err.hidden = false;
    return;
  }
  times.sort();

  let stock = null;
  if (stockRaw !== '') {
    const n = parseInt(stockRaw, 10);
    if (isNaN(n) || n < 0) {
      err.textContent = 'Adet bilgisi 0 veya daha büyük bir sayı olmalı.';
      err.hidden = false;
      return;
    }
    stock = n;
  }

  if (editingMedId) {
    const med = medById(editingMedId);
    const oldTimes = med.times.slice();
    med.name = name;
    med.dosageNote = note;
    med.stockCount = stock;
    // Aynı saat korunuyorsa timeId'yi koru (geçmiş loglar bozulmasın)
    med.times = times.map((t) => {
      const prev = oldTimes.find((o) => o.time === t);
      return prev ? prev : { id: uid(), time: t };
    });
    // Silinen/değişen saatlerin bugünkü bekleyen kayıtlarını temizle
    const validIds = new Set(med.times.map((t) => t.id));
    state.logs = state.logs.filter(
      (l) => !(l.medicationId === med.id && l.status === 'bekliyor' && !validIds.has(l.timeId))
    );
    toast(name + ' güncellendi.');
  } else {
    state.medications.push({
      id: uid(),
      name: name,
      dosageNote: note,
      times: times.map((t) => ({ id: uid(), time: t })),
      stockCount: stock,
      active: true,
      createdAt: new Date().toISOString()
    });
    toast(name + ' eklendi.');
  }

  ensureLogsForDate(todayStr());
  save();
  closeMedModal();
  render();
}

/* ---------------------- Onay diyaloğu ---------------------- */

function confirmDialog(text) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-text').textContent = text;
    modal.hidden = false;

    const yes = $('#confirm-yes');
    const no  = $('#confirm-no');

    function cleanup(result) {
      modal.hidden = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(result);
    }
    function onYes() { cleanup(true); }
    function onNo()  { cleanup(false); }

    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  });
}

/* ---------------------- Yedekleme ---------------------- */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ilac-yedek-' + todayStr() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Yedek dosyası indirildi.');
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.medications) || !Array.isArray(data.logs)) {
      toast('Dosya geçerli bir yedek değil.');
      return;
    }
    const ok = await confirmDialog('Mevcut veriler silinip yedek yüklensin mi?');
    if (!ok) return;
    state.medications = data.medications;
    state.logs = data.logs;
    state.settings = Object.assign({ lastEnsuredDate: null, notifAsked: true }, data.settings || {});
    backfillLogs();
    save();
    render();
    toast('Yedek yüklendi.');
  } catch (err) {
    console.error(err);
    toast('Yedek yüklenemedi: dosya okunamadı.');
  }
}

/* ---------------------- Service Worker köprüsü ---------------------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ilacTakipDB', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pendingActions')) {
        db.createObjectStore('pendingActions', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Uygulama kapalıyken bildirimden yapılan seçimleri işler. */
async function drainPendingActions() {
  if (!('indexedDB' in window)) return;
  let db;
  try { db = await idbOpen(); } catch (e) { return; }

  const items = await new Promise((resolve) => {
    const tx = db.transaction('pendingActions', 'readonly');
    const req = tx.objectStore('pendingActions').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });

  if (items.length) {
    items
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .forEach((item) => applyRemoteAction(item.action, item.logId, item.at));

    await new Promise((resolve) => {
      const tx = db.transaction('pendingActions', 'readwrite');
      tx.objectStore('pendingActions').clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    save();
  }
  db.close();
}

function applyRemoteAction(action, logId, at) {
  if (action === 'confirm')  markTaken(logId, at);
  if (action === 'snooze15') snoozeLog(logId, 15, at);
  if (action === 'snooze30') snoozeLog(logId, 30, at);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Worker desteklenmiyor.');
    return;
  }
  try {
    swReg = await navigator.serviceWorker.register('service-worker.js');
    await navigator.serviceWorker.ready;
    swReg = await navigator.serviceWorker.getRegistration() || swReg;
  } catch (err) {
    console.error('Service Worker kaydedilemedi:', err);
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'notification-action') {
      applyRemoteAction(msg.action, msg.logId, msg.at);
    }
  });
}

/* ---------------------- Görünüm yönetimi ---------------------- */

function switchView(name) {
  currentView = name;
  ['bugun', 'ilaclar', 'takvim'].forEach((v) => {
    $('#view-' + v).hidden = (v !== name);
  });
  $$('.tab').forEach((t) => t.classList.toggle('tab-active', t.dataset.view === name));
  render();
  window.scrollTo(0, 0);
}

function render() {
  renderBanners();
  if (currentView === 'bugun')   renderToday();
  if (currentView === 'ilaclar') { renderMeds(); renderStorageInfo(); }
  if (currentView === 'takvim')  renderCalendar();
}

/* ---------------------- Başlangıç ---------------------- */

function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#btn-add-med').addEventListener('click', () => openMedModal(null));
  $('#btn-add-time').addEventListener('click', () => addTimeRow(''));
  $('#btn-cancel-med').addEventListener('click', closeMedModal);
  $('#med-form').addEventListener('submit', submitMedForm);

  $('#btn-close-day').addEventListener('click', () => { $('#day-modal').hidden = true; });

  $('#cal-prev').addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  });

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });

  // Modal dışına tıklayınca kapat
  $('#med-modal').addEventListener('click', (e) => { if (e.target.id === 'med-modal') closeMedModal(); });
  $('#day-modal').addEventListener('click', (e) => { if (e.target.id === 'day-modal') e.currentTarget.hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#med-modal').hidden) closeMedModal();
    else if (!$('#day-modal').hidden) $('#day-modal').hidden = true;
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);

  // Android: Chrome kurulabilir olduğunu bildirdiğinde kendi butonumuzu gösterelim
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    renderBanners();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    toast('Uygulama ana ekrana kuruldu. Bundan sonra oradaki simgeden açın.', 6000);
    renderBanners();
  });
}

/** İlaçlar sekmesindeki depolama durumu satırı */
async function renderStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;

  const parts = [];
  parts.push(storageOk ? 'Kayıt: çalışıyor' : 'Kayıt: ÇALIŞMIYOR (' + storageErrName + ')');
  parts.push(isStandalone() ? 'Açılış: uygulama olarak' : 'Açılış: tarayıcı sekmesi');

  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    parts.push('Veri boyutu: ' + Math.max(1, Math.round(raw.length / 1024)) + ' KB');
  } catch (err) { /* okunamıyorsa boş geç */ }

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        parts.push('Tarayıcı alanı: ' + Math.round(est.quota / 1048576) + ' MB (kullanılan ' +
                   Math.round((est.usage || 0) / 1024) + ' KB)');
      }
    } catch (err) { /* desteklenmiyorsa boş geç */ }
  }

  el.textContent = parts.join(' · ');
}

async function init() {
  checkStorage();
  load();
  backfillLogs();
  autoMarkMissed();
  save();

  bindEvents();
  updateClock();
  render();

  await registerServiceWorker();
  await drainPendingActions();

  // Tarayıcı yer açmak için verilerimizi silmesin
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (err) { /* zorunlu değil */ }
  }

  // İlk açılışta bildirim izni iste (izin verilmemişse şerit görünür kalır)
  if (notifPermission() === 'default' && !state.settings.notifAsked) {
    state.settings.notifAsked = true;
    save();
    try { await Notification.requestPermission(); } catch (e) { /* kullanıcı hareketi gerekebilir */ }
  }

  render();
  tick();
  setInterval(tick, TICK_MS);
}

init();
