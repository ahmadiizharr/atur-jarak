// UI peta (Leaflet + OpenStreetMap) untuk menggambar jalur kabel A→B→POP dan menghitung RAB.
import { KATALOG, BAGIAN } from './katalog.js';
import {
  opsiDefault, ringkasan, hitungRAB, totalRAB, subtotalRAB, pakaiKabel24, jarak, proyeksi, jbDalamRadius, jbDekatJalur, lewatJB,
  terdekat, tandaiArahPOP, jumlahTracing, jumlahJointing, coreKabel, perluTransport,
} from './hitung.js';
import { queryOverpass, bboxUntuk, bboxBerisi, bangunGraf, ruteMelalui, grafOffline } from './rute.js';
import { DAFTAR_POP } from './pop.js';
import { DAFTAR_JB } from './jb.js';

const STORE = 'rabJalurKabel.v1';
const PUSAT = { lat: 0.9086, lng: 108.9866 }; // Singkawang
const NAMA_TITIK = { A: 'A — Pelanggan', B: 'B — Titik sambung', POP: 'POP' };
// Data jalan OSM (gratis). PROXY_LOKAL = server.py: mencoba 8 server/mirror Overpass dari sisi server,
// jadi mirror yang tidak mengizinkan CORS (mis. kumi.systems) tetap bisa dipakai.
const PROXY_LOKAL = '/overpass';
// Dipanggil langsung dari browser (mengizinkan CORS) kalau aplikasi dibuka tanpa server.py, atau dipilih manual.
const SERVER_OVERPASS = [
  { url: 'https://overpass.openstreetmap.fr/api/interpreter', nama: 'overpass.openstreetmap.fr (Prancis)' },
  { url: 'https://overpass-api.de/api/interpreter', nama: 'overpass-api.de (Jerman, utama)' },
  { url: 'https://z.overpass-api.de/api/interpreter', nama: 'z.overpass-api.de (Jerman)' },
  { url: 'https://lz4.overpass-api.de/api/interpreter', nama: 'lz4.overpass-api.de (Jerman)' },
  { url: 'https://overpass.private.coffee/api/interpreter', nama: 'overpass.private.coffee (Austria)' },
];
const JEDA_GAGAL_MS = 120000; // server yang baru gagal ditaruh di urutan belakang selama 2 menit
const ZOOM_TIANG = 16; // di bawah zoom ini titik tiang tidak digambar (terlalu rapat)
const FILE_JALAN_OFFLINE = 'jalan-kalbar.json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const angka = (n) => Math.round(n).toLocaleString('id-ID');
const rupiah = (n) => 'Rp ' + angka(n);
const fmtKoord = (t) => (t ? `${t.lat.toFixed(6)}, ${t.lng.toFixed(6)}` : '');
const ll = (latlng) => ({ lat: +latlng.lat.toFixed(7), lng: +latlng.lng.toFixed(7) });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const buatId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const linkGmaps = (t) => `https://www.google.com/maps/search/?api=1&query=${t.lat},${t.lng}`;
const linkStreetView = (t) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${t.lat},${t.lng}`;

/** '0.908456, 109.0102 (IFT)' -> {lat, lng}; null kalau bukan koordinat. */
function parseKoord(teks) {
  const m = String(teks).match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// ---------------------------------------------------------------- data project

function projectBaru(nama) {
  return {
    id: buatId(), nama, pelanggan: '', noPO: '',
    A: null, B: null, bNama: '', POP: null, popNama: '', viaAB: [], viaBPOP: [], jbDilepas: [],
    modeAB: 'jalan', modeBPOP: 'jalan',
    ruteAB: null, legAB: [], kunciAB: '', ruteBPOP: null, legBPOP: [], kunciBPOP: '',
    opsi: opsiDefault(), ubahTiang: null, ubahRAB: {},
    dibuat: Date.now(), diubah: Date.now(),
  };
}

/** Lengkapi field project lama / hasil import dengan nilai default. */
function rapikan(proj) {
  return { ...projectBaru(proj.nama || 'Project'), ...proj, opsi: { ...opsiDefault(), ...(proj.opsi || {}) }, ubahRAB: proj.ubahRAB || {} };
}

function muat() {
  const mentah = localStorage.getItem(STORE);
  if (mentah) {
    try {
      const d = JSON.parse(mentah);
      if (d?.projects?.length) return { projects: d.projects.map(rapikan), aktif: d.aktif };
    } catch (err) {
      // Simpan salinan data yang rusak supaya tidak tertimpa diam-diam.
      localStorage.setItem(`${STORE}.rusak.${Date.now()}`, mentah);
      console.error('Data project rusak, disalin ke cadangan:', err);
    }
  }
  const pr = projectBaru('Project 1');
  return { projects: [pr], aktif: pr.id };
}

let db = muat();
let p = db.projects.find((x) => x.id === db.aktif) || db.projects[0];
let tool = null;

function simpan() {
  p.diubah = Date.now();
  db.aktif = p.id;
  localStorage.setItem(STORE, JSON.stringify(db));
}

// ---------------------------------------------------------------- jalur & hitung

const titikAB = (pr) => (pr.A && pr.B ? [pr.A, ...pr.viaAB, pr.B] : []);
const titikBPOP = (pr) => (pr.B && pr.POP ? [pr.B, ...pr.viaBPOP, pr.POP] : []);
// Rute tersimpan hanya berlaku untuk titik & kelas jalan yang sama persis.
const kunciRute = (pr, titik) => JSON.stringify([pr.opsi.kelasJalan, titik]);
// Mode 'jb' (ikuti jalur JB) memakai rute jalan sebagai dasar, lalu dibelokkan lewat JB terdekat.
const ikutJalan = (mode) => mode === 'jalan' || mode === 'jb';
const ruteValid = (pr, key, titik) => ikutJalan(pr[`mode${key}`]) && pr[`rute${key}`] && pr[`kunci${key}`] === kunciRute(pr, titik);
const jalurAB = (pr) => (ruteValid(pr, 'AB', titikAB(pr)) ? pr.ruteAB : titikAB(pr));
const kunciJB = (nama, lat, lng) => `${nama}|${lat}|${lng}`;

/** Daftar JB tanpa JB yang dilepas (unpin) user di project ini: tidak dilewati jalur & tidak dihitung tracing. */
function jbAktif(pr) {
  if (!pr.jbDilepas?.length) return DAFTAR_JB;
  const lepas = new Set(pr.jbDilepas);
  return DAFTAR_JB.filter(([nama, lat, lng]) => !lepas.has(kunciJB(nama, lat, lng)));
}

function jalurBPOP(pr) {
  const dasar = ruteValid(pr, 'BPOP', titikBPOP(pr)) ? pr.ruteBPOP : titikBPOP(pr);
  if (pr.modeBPOP !== 'jb') return dasar;
  // Ikuti jalur JB: lewat tepat di semua JB (yang tidak dilepas) sejauh <= radiusJB dari jalur dasar.
  return lewatJB(dasar, jbDekatJalur(dasar, jbAktif(pr), Number(pr.opsi.radiusJB) || 0));
}
// Jalur ikut jalan berisi banyak titik geometri, jadi tiang selalu otomatis.
const opsiEfektif = (pr) => (pr.modeAB === 'jalan' ? { ...pr.opsi, modeTiang: 'otomatis' } : pr.opsi);

function hitungProject(pr) {
  const ab = jalurAB(pr);
  const bp = jalurBPOP(pr);
  const opsi = opsiEfektif(pr);
  // Ubahan per tiang hanya berlaku selama jumlah tiang tidak berubah.
  const n = ringkasan(ab, [], opsi).tiang.length;
  const r = ringkasan(ab, bp, opsi, pr.ubahTiang?.n === n ? pr.ubahTiang.data : {}, jbAktif(pr));
  // B dipilih dari daftar JB = JB existing (tapping), jadi tidak perlu Joint Box baru di B.
  return { r, rab: hitungRAB(r, pr.opsi, pr.ubahRAB, { bJBExisting: !!pr.bNama }) };
}

let cariB = false; // mode memilih titik B dari JB dalam radius A (tidak disimpan, mati saat halaman dimuat)

/**
 * Set titik A/B/POP. B/POP yang dipindah manual bukan lagi JB/POP dari daftar, jadi namanya dikosongkan.
 * A baru tanpa B -> langsung tampilkan JB sekitar A untuk memilih B.
 */
function aturTitik(key, t) {
  p[key] = t;
  if (key === 'POP') p.popNama = '';
  if (key === 'B') p.bNama = '';
  if (key === 'A' && t && !p.B) cariB = true;
}

/** Label titik untuk tooltip / ekspor, termasuk nama JB (B) atau POP dari daftar. */
function namaTitik(key, html = true) {
  const nama = key === 'B' ? p.bNama : key === 'POP' ? p.popNama : '';
  const teks = nama ? `${key === 'B' ? 'B (JB tapping)' : 'POP'} — ${nama}` : NAMA_TITIK[key];
  return html ? esc(teks) : teks;
}

/** Pilih JB sebagai titik B (tapping). */
function pilihB(j) {
  aturTitik('B', { lat: j.lat, lng: j.lng });
  p.bNama = j.nama;
  cariB = false;
  map.closePopup();
  ubah({ rute: true });
  if (!p.POP) $('#pilihPOP').focus();
}

/** Pakai POP dari daftar sebagai titik POP. */
function pakaiPOP(pop) {
  aturTitik('POP', { lat: pop.lat, lng: pop.lng });
  p.popNama = pop.nama;
  ubah({ rute: true });
}

/** POP acuan arah saat memilih B: POP yang sudah dipilih, kalau belum ada POP terdekat dari A. */
function popAcuanB() {
  if (!p.A) return null;
  if (p.POP) return { nama: p.popNama || 'POP (manual)', lat: p.POP.lat, lng: p.POP.lng, jarak: jarak(p.A, p.POP), dipilih: true };
  return terdekat(p.A, DAFTAR_POP);
}

const radiusCariB = () => Math.max(Number(p.opsi.radiusCariB) || 5, 0.5) * 1000;
/** JB dalam radius A, ditandai searah/menjauh terhadap POP acuan; yang searah di atas, masing-masing urut terdekat ke A. */
function kandidatB() {
  if (!p.A) return [];
  const pop = popAcuanB();
  const jbs = jbDalamRadius(p.A, DAFTAR_JB, radiusCariB());
  return pop ? tandaiArahPOP(p.A, jbs, pop).sort((a, b) => (b.searah - a.searah) || (a.jarak - b.jarak)) : jbs;
}
const lihatRadiusB = () => p.A && map.fitBounds(L.latLng(p.A).toBounds(radiusCariB() * 2), { padding: [20, 20] });

function dataUbahTiang(n) {
  if (!p.ubahTiang || p.ubahTiang.n !== n) p.ubahTiang = { n, data: {} };
  return p.ubahTiang.data;
}

// kelas jalan -> { bbox, graf }: data jalan area terakhir per kelas, supaya geser titik tidak unduh ulang.
const cacheGraf = new Map();

// Data jalan yang sudah diunduh disimpan di cache browser, supaya area yang sama tidak diminta lagi ke server
// (server Overpass gratis membatasi jumlah permintaan per IP).
const CACHE_JALAN = 'rab-jalan-v1';
const INDEKS_JALAN = `${STORE}.jalan`; // [{ kelas, bbox, kunci }]
const indeksJalan = () => JSON.parse(localStorage.getItem(INDEKS_JALAN) || '[]');

async function grafTersimpan(perlu, kelas) {
  const ada = indeksJalan().find((x) => x.kelas === kelas && bboxBerisi(x.bbox, perlu));
  if (!ada || !window.caches) return null;
  const res = await (await caches.open(CACHE_JALAN)).match(ada.kunci);
  return res ? { bbox: ada.bbox, graf: bangunGraf(await res.json()) } : null;
}

async function simpanGraf(bbox, kelas, teks) {
  if (!window.caches) return;
  const kunci = `/cache-jalan/${kelas}/${[bbox.s, bbox.w, bbox.n, bbox.e].map((v) => v.toFixed(4)).join(',')}`;
  await (await caches.open(CACHE_JALAN)).put(kunci, new Response(teks, { headers: { 'Content-Type': 'application/json' } }));
  localStorage.setItem(INDEKS_JALAN, JSON.stringify([...indeksJalan().filter((x) => x.kunci !== kunci), { kelas, bbox, kunci }].slice(-40)));
}

async function hapusCacheJalan() {
  cacheGraf.clear();
  localStorage.removeItem(INDEKS_JALAN);
  if (window.caches) await caches.delete(CACHE_JALAN);
}

// Data jalan offline Kalbar (dibuat oleh tools/unduh_jalan_kalbar.py). undefined = belum dimuat, null = tidak ada.
let dataOffline;
async function muatDataOffline() {
  if (dataOffline !== undefined) return dataOffline;
  try {
    const res = await fetch(FILE_JALAN_OFFLINE);
    dataOffline = res.ok ? await res.json() : null;
  } catch (err) {
    console.warn('Data jalan offline tidak bisa dibaca, pakai server Overpass:', err);
    dataOffline = null;
  }
  return dataOffline;
}

// Pengaturan aplikasi (berlaku untuk semua project).
const PENGATURAN = `${STORE}.pengaturan`;
const pengaturan = { server: 'otomatis', serverSendiri: '', offline: false, ...JSON.parse(localStorage.getItem(PENGATURAN) || '{}') };
const simpanPengaturan = () => localStorage.setItem(PENGATURAN, JSON.stringify(pengaturan));

const SERVER_OK = `${STORE}.serverOk`; // server langsung terakhir yang berhasil, dicoba duluan
const gagalSampai = new Map(); // url -> waktu (ms) sampai kapan server ditaruh di belakang
let proxyAda = true; // false kalau aplikasi dibuka tanpa server.py
let sumberJalan = ''; // dari mana data jalan terakhir didapat (ditampilkan di ringkasan)

/** Urutan server sesuai pengaturan: otomatis = proxy lokal dulu, lalu server langsung (terakhir berhasil dulu). */
function daftarServer() {
  if (pengaturan.server === 'sendiri') return pengaturan.serverSendiri.trim() ? [pengaturan.serverSendiri.trim()] : [];
  if (pengaturan.server !== 'otomatis') return [pengaturan.server];
  const terakhir = localStorage.getItem(SERVER_OK);
  const sekarang = Date.now();
  const gagal = (u) => (gagalSampai.get(u) || 0) > sekarang;
  const langsung = SERVER_OVERPASS.map((s) => s.url).sort((a, b) => ((b === terakhir) - (a === terakhir)) || (gagal(a) - gagal(b)));
  return [...(proxyAda ? [PROXY_LOKAL] : []), ...langsung];
}

/** Kirim query ke server satu per satu sampai ada yang berhasil. */
async function ambilOverpass(query) {
  const galat = [];
  for (const url of daftarServer()) {
    const lokal = url === PROXY_LOKAL;
    const host = lokal ? 'proxy lokal' : new URL(url, location.href).host;
    status(`Mengambil data jalan dari ${host}…`);
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(lokal ? 130000 : 25000) });
      if (lokal && (res.status === 404 || res.status === 501)) {
        proxyAda = false; // dibuka lewat server lain (bukan server.py): pakai server langsung saja
        continue;
      }
      if (!res.ok) {
        const detail = lokal ? (await res.json().catch(() => ({}))).detail : '';
        // Proxy lokal sudah mencoba semua mirror; tidak perlu diulang lagi dari browser.
        throw Object.assign(new Error(detail || `HTTP ${res.status}`), { akhir: lokal });
      }
      const teks = await res.text();
      const js = JSON.parse(teks);
      // Server yang kelebihan beban menjawab 200 tapi tanpa data + "remark"; jangan dianggap "tidak ada jalan".
      if (js.remark && !js.elements?.length) throw new Error(js.remark);
      if (!lokal) localStorage.setItem(SERVER_OK, url);
      return { js, teks, dari: res.headers.get('X-Overpass-Server') || host };
    } catch (err) {
      const pesan = err.name === 'TimeoutError' ? 'tidak merespons' : err.message === 'Failed to fetch' ? 'ditolak/terputus' : err.message;
      galat.push(`${host}: ${pesan}`);
      if (!lokal) gagalSampai.set(url, Date.now() + JEDA_GAGAL_MS);
      if (err.akhir) break;
    }
  }
  throw new Error(`semua server data jalan gagal (${galat.join('; ') || 'belum ada server dipilih'}). `
    + 'Coba ↻ Hitung ulang rute, pilih server lain, atau nyalakan data jalan offline');
}

async function grafJalan(titik, kelas) {
  const perlu = bboxUntuk(titik, 0.003);
  const diMemori = cacheGraf.get(kelas);
  if (diMemori && bboxBerisi(diMemori.bbox, perlu)) return diMemori.graf;
  // Area agak luas (±3 km) supaya geser titik / project lain di kota yang sama tidak perlu memuat ulang.
  const bbox = bboxUntuk(titik, 0.03);
  // 1. (Opsional) data offline di folder aplikasi: tanpa internet, tanpa batas permintaan.
  if (pengaturan.offline) {
    const offline = grafOffline(await muatDataOffline(), bbox, kelas, perlu);
    if (offline?.edges.length) {
      cacheGraf.set(kelas, { bbox, graf: offline });
      sumberJalan = 'file offline';
      return offline;
    }
  }
  // 2. Data yang pernah diunduh dari server dan tersimpan di cache browser.
  const tersimpan = await grafTersimpan(perlu, kelas).catch((err) => console.warn('Cache data jalan tidak terbaca:', err));
  if (tersimpan) {
    cacheGraf.set(kelas, tersimpan);
    sumberJalan = 'cache browser';
    return tersimpan.graf;
  }
  // 3. Server Overpass (proxy lokal + banyak mirror).
  // Area terlalu luas = unduhan data jalan sangat besar dan server menolak; gambar manual saja.
  if (bbox.n - bbox.s > 0.6 || bbox.e - bbox.w > 0.6) throw new Error('titik terlalu berjauhan (lebih dari ±40 km), pakai mode Manual');
  const { js, teks, dari } = await ambilOverpass(queryOverpass(bbox, kelas));
  const graf = bangunGraf(js);
  cacheGraf.set(kelas, { bbox, graf });
  sumberJalan = dari;
  simpanGraf(bbox, kelas, teks).catch((err) => console.warn('Data jalan gagal disimpan ke cache:', err));
  return graf;
}

async function perbaruiRute() {
  const pr = p;
  const tugas = [['AB', titikAB(pr)], ['BPOP', titikBPOP(pr)]]
    .filter(([key, titik]) => ikutJalan(pr[`mode${key}`]) && titik.length >= 2 && !ruteValid(pr, key, titik));
  if (!tugas.length) return;
  status('Menghitung rute jalan…');
  try {
    const semua = [pr.A, pr.B, pr.POP, ...pr.viaAB, ...pr.viaBPOP].filter(Boolean);
    const kelas = pr.opsi.kelasJalan;
    const graf = await grafJalan(semua, kelas);
    // Titik belok yang ditambah user diprioritaskan: kalau ada di jalan kecil, leg-nya boleh lewat jalan lingkungan.
    const adaTitikUser = tugas.some(([key]) => pr[`via${key}`].length);
    const grafBebas = adaTitikUser && kelas !== 'lingkungan'
      ? await grafJalan(semua, 'lingkungan').catch((err) => {
        console.warn('Data jalan lingkungan gagal diambil, titik belok dicapai dari jalan terpilih:', err);
        return null;
      })
      : null;
    for (const [key, titik] of tugas) {
      const kunci = kunciRute(pr, titik);
      // Titik sudah digeser lagi selama menunggu data -> hasil ini basi, biar panggilan berikutnya yang menyimpan.
      if (kunci !== kunciRute(pr, key === 'AB' ? titikAB(pr) : titikBPOP(pr))) continue;
      // Di titikAB/titikBPOP, titik belok user ada di indeks 1..n (indeks 0 = A/B, terakhir = B/POP).
      const wajib = new Set(pr[`via${key}`].map((_, i) => i + 1));
      // Titik lain yang juga dipilih user: A & B di jalur A→B, B (JB tapping) di jalur B→POP. POP bukan.
      const titikUser = new Set(key === 'AB' ? [0, titik.length - 1] : [0]);
      const hasil = ruteMelalui(graf, titik, { grafBebas, wajib, titikUser });
      pr[`rute${key}`] = hasil.titik;
      pr[`leg${key}`] = hasil.legAwal;
      pr[`kunci${key}`] = kunci;
    }
  } catch (err) {
    toast(`Rute jalan besar gagal: ${err.message}. Sementara dipakai garis lurus.`, 10000);
  }
  status('');
  localStorage.setItem(STORE, JSON.stringify(db));
  if (pr === p) renderSemua();
}

let timerRute = 0;
function ubah({ rute = false } = {}) {
  renderSemua();
  simpan();
  if (rute) {
    clearTimeout(timerRute);
    timerRute = setTimeout(perbaruiRute, 350);
  }
}

// ---------------------------------------------------------------- peta

const map = L.map('peta').setView(PUSAT, 14);
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const satelit = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  maxNativeZoom: 18,
  attribution: 'Citra &copy; Esri',
});
L.control.layers({ OpenStreetMap: osm, 'Satelit (Esri)': satelit }, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const lapisan = L.layerGroup().addTo(map);

const ikonPin = (key) => L.divIcon({ className: '', html: `<div class="pin pin-${key}"><span>${key === 'POP' ? 'POP' : key}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 36] });
const ikonVia = (jalur) => L.divIcon({ className: '', html: `<div class="via via-${jalur}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
// Jenis suspension/deadend sengaja tidak ditampilkan di peta, hanya dipakai di perhitungan RAB.
const ikonTiang = (t) => L.divIcon({ className: '', html: `<div class="tiang${t.baru ? ' baru' : ''}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });

/** Indeks di daftar titik belok tempat titik baru disisipkan: leg jalur yang paling dekat dengan pt. */
function indeksSisip(key, pt) {
  const titik = key === 'AB' ? titikAB(p) : titikBPOP(p);
  const terdekat = (garis) => {
    let idx = 0;
    let min = Infinity;
    for (let i = 1; i < garis.length; i++) {
      const d = proyeksi(pt, garis[i - 1], garis[i]).d;
      if (d < min) [min, idx] = [d, i - 1];
    }
    return idx;
  };
  if (!ruteValid(p, key, titik)) return terdekat(titik);
  // Jalur ikut jalan: segmen rute terdekat -> leg yang memuat segmen itu.
  const seg = terdekat(p[`rute${key}`]);
  return p[`leg${key}`].filter((awal) => awal <= seg).length - 1;
}

let tarikBaruSaja = false; // klik peta yang menyusul setelah menarik garis diabaikan

/** Tarik garis jalur untuk membuat titik belok baru, seperti menggeser rute di Google Maps. */
function mulaiTarik(key, e) {
  if ((tool && tool !== key) || e.originalEvent.button !== 0) return; // alat lain aktif: biarkan jadi klik peta biasa
  L.DomEvent.stop(e);
  map.dragging.disable();
  const via = key === 'AB' ? p.viaAB : p.viaBPOP;
  const titik = key === 'AB' ? titikAB(p) : titikBPOP(p);
  const idx = indeksSisip(key, ll(e.latlng));
  const [sebelum, sesudah] = [titik[idx], titik[idx + 1]];
  const asal = e.containerPoint;
  let bergerak = false;
  const bayangan = L.polyline([sebelum, e.latlng, sesudah], { color: '#111827', weight: 2, dashArray: '4 4', interactive: false }).addTo(map);
  const pegangan = L.marker(e.latlng, { icon: ikonVia(key), interactive: false }).addTo(map);
  const gerak = (ev) => {
    if (ev.containerPoint.distanceTo(asal) > 4) bergerak = true;
    pegangan.setLatLng(ev.latlng);
    bayangan.setLatLngs([sebelum, ev.latlng, sesudah]);
  };
  const lepas = () => {
    map.off('mousemove', gerak);
    bayangan.remove();
    pegangan.remove();
    map.dragging.enable();
    if (!bergerak && tool !== key) return; // cuma klik garis tanpa alat aktif
    via.splice(idx, 0, ll(pegangan.getLatLng()));
    tarikBaruSaja = true;
    setTimeout(() => { tarikBaruSaja = false; }, 50);
    ubah({ rute: true });
  };
  map.on('mousemove', gerak);
  document.addEventListener('mouseup', lepas, { once: true });
}

function garisJalur(key, jalur, label) {
  if (jalur.length < 2) return;
  const gaya = key === 'AB' ? { color: '#dc2626', weight: 6 } : { color: '#2563eb', weight: 5, dashArray: '8 6' };
  const garis = L.polyline(jalur, { ...gaya, className: 'garis-tarik' }).addTo(lapisan);
  garis.bindTooltip(`${label}<br><small>Tarik garis untuk membelokkan jalur</small>`, { sticky: true });
  garis.on('mousedown', (e) => mulaiTarik(key, e));
}

function markerVia(key, i) {
  const via = key === 'AB' ? p.viaAB : p.viaBPOP;
  const m = L.marker(via[i], { icon: ikonVia(key), draggable: true, zIndexOffset: 300 }).addTo(lapisan);
  m.bindTooltip('Titik belok — geser untuk pindah, klik kanan untuk hapus');
  m.on('dragend', (e) => { via[i] = ll(e.target.getLatLng()); ubah({ rute: true }); });
  m.on('contextmenu', () => { via.splice(i, 1); ubah({ rute: true }); });
}

function popupTiang(t, n) {
  const div = document.createElement('div');
  div.className = 'popup-tiang';
  div.innerHTML = `<b>Tiang ${t.no} dari ${n}</b> · ${t.baru ? 'tiang baru' : 'tiang existing'}<br>
    <small>${fmtKoord(t)}</small>
    <div class="row"><button data-aksi="baru">${t.baru ? 'Tandai existing' : 'Tandai tiang baru'}</button></div>
    <div class="row"><a href="${linkStreetView(t)}" target="_blank" rel="noopener">Street View</a>
      <a href="${linkGmaps(t)}" target="_blank" rel="noopener">Google Maps</a></div>`;
  div.addEventListener('click', (e) => {
    if (e.target.dataset.aksi !== 'baru') return;
    const data = dataUbahTiang(n);
    data[t.no] = { ...data[t.no], baru: !t.baru };
    map.closePopup();
    ubah();
  });
  return div;
}

const ikonJB = (dihitung) => L.divIcon({ className: '', html: `<div class="jb ${dihitung ? 'jb-tracing' : 'jb-ref'}">JB</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });

/** JB hanya tampil kalau ada jalur B→POP: yang dilewati (dihitung tracing) dan yang dekat (referensi arah ke POP). */
function markerJB(j, dihitung) {
  const m = L.marker(j, { icon: ikonJB(dihitung), zIndexOffset: dihitung ? 200 : 100 }).addTo(lapisan);
  m.bindTooltip(`${esc(j.nama)} — ${dihitung ? 'dilewati, dihitung tracing' : `${angka(j.jarak)} m dari jalur (referensi)`}`);
  const div = document.createElement('div');
  div.className = 'popup-tiang';
  div.innerHTML = `<b>${esc(j.nama)}</b><br>
    ${dihitung ? 'Dilewati jalur B→POP, dihitung tracing' : `${angka(j.jarak)} m dari jalur B→POP, tidak dihitung`}<br>
    <small>${fmtKoord(j)}</small>
    <div class="row"><button data-aksi="b">Jadikan titik B</button>${dihitung
    ? '<button data-aksi="lepas" title="Jalur tidak dibelokkan ke JB ini dan JB ini tidak dihitung tracing">Lepas JB ini</button>'
    : '<button data-aksi="lewat">Lewatkan B→POP di sini</button>'}</div>
    <div class="row"><a href="${linkStreetView(j)}" target="_blank" rel="noopener">Street View</a>
      <a href="${linkGmaps(j)}" target="_blank" rel="noopener">Google Maps</a></div>`;
  div.addEventListener('click', (e) => {
    const pt = { lat: j.lat, lng: j.lng };
    if (e.target.dataset.aksi === 'b') return pilihB(j); // JB existing jadi titik B (tapping)
    if (e.target.dataset.aksi === 'lepas') p.jbDilepas = [...(p.jbDilepas || []), kunciJB(j.nama, j.lat, j.lng)];
    else if (e.target.dataset.aksi === 'lewat') p.viaBPOP.splice(indeksSisip('BPOP', pt), 0, pt);
    else return;
    map.closePopup();
    ubah({ rute: true });
  });
  m.bindPopup(div);
}

/** POP terdekat dari A (belum dipilih) saat memilih B; klik untuk langsung dipakai. */
function markerSaranPOP(pop) {
  const ikon = L.divIcon({ className: '', html: '<div class="pin pin-POP saran"><span>POP</span></div>', iconSize: [30, 30], iconAnchor: [15, 36] });
  const m = L.marker(pop, { icon: ikon, zIndexOffset: 900 }).addTo(lapisan);
  m.bindTooltip(`POP terdekat: ${esc(pop.nama)} — ${fmtJarak(pop.jarak)} dari A`);
  const div = document.createElement('div');
  div.className = 'popup-tiang';
  div.innerHTML = `<b>${esc(pop.nama)}</b><br>POP terdekat, ${fmtJarak(pop.jarak)} dari A<div class="row"><button data-aksi="pop">Pakai POP ini</button></div>`;
  div.addEventListener('click', (e) => {
    if (e.target.dataset.aksi !== 'pop') return;
    map.closePopup();
    pakaiPOP(pop);
  });
  m.bindPopup(div);
}

/** Teks arah JB terhadap POP acuan. */
const teksArah = (j) => (j.keP == null ? '' : `ke POP ${fmtJarak(j.keP)} ${j.searah ? '✓ searah' : '⚠ menjauh dari POP'}`);

/** JB dalam radius A, kandidat titik B (hijau = searah ke POP, merah = menjauh). */
/** JB yang dilepas (unpin): tidak dilewati jalur & tidak dihitung tracing; klik untuk dipakai lagi. */
function markerJBLepas(j) {
  const ikon = L.divIcon({ className: '', html: '<div class="jb jb-lepas">JB</div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  const m = L.marker(j, { icon: ikon, zIndexOffset: 90 }).addTo(lapisan);
  m.bindTooltip(`${esc(j.nama)} — dilepas, tidak dilewati`);
  const div = document.createElement('div');
  div.className = 'popup-tiang';
  div.innerHTML = `<b>${esc(j.nama)}</b><br>Dilepas: jalur tidak dibelokkan ke JB ini dan tidak dihitung tracing
    <div class="row"><button data-aksi="pakai">Pakai lagi JB ini</button></div>`;
  div.addEventListener('click', (e) => {
    if (e.target.dataset.aksi !== 'pakai') return;
    p.jbDilepas = (p.jbDilepas || []).filter((k) => k !== j.kunci);
    map.closePopup();
    ubah();
  });
  m.bindPopup(div);
}

function markerKandidatB(j) {
  const kelas = j.searah === false ? 'jb jb-kandidat menjauh' : 'jb jb-kandidat';
  const m = L.marker(j, { icon: L.divIcon({ className: '', html: `<div class="${kelas}">JB</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: j.searah === false ? 140 : 150 }).addTo(lapisan);
  m.bindTooltip(`${esc(j.nama)} — ${fmtJarak(j.jarak)} dari A${j.keP == null ? '' : ` · ${teksArah(j)}`}`);
  const div = document.createElement('div');
  div.className = 'popup-tiang';
  div.innerHTML = `<b>${esc(j.nama)}</b><br>${fmtJarak(j.jarak)} dari A (garis lurus)<br>
    ${j.keP == null ? '' : `${j.searah ? '' : '<b style="color:#b91c1c">⚠</b> '}${esc(teksArah(j))}<br>`}<small>${fmtKoord(j)}</small>
    <div class="row"><button data-aksi="b">Jadikan titik B</button></div>
    <div class="row"><a href="${linkStreetView(j)}" target="_blank" rel="noopener">Street View</a>
      <a href="${linkGmaps(j)}" target="_blank" rel="noopener">Google Maps</a></div>`;
  div.addEventListener('click', (e) => { if (e.target.dataset.aksi === 'b') pilihB(j); });
  m.bindPopup(div);
}

function renderPeta(r) {
  lapisan.clearLayers();
  if (cariB && p.A) {
    L.circle(p.A, { radius: radiusCariB(), color: '#0d9488', weight: 2, dashArray: '6 6', fillOpacity: 0.05, interactive: false }).addTo(lapisan);
    // Arah ke POP (yang dipilih, atau POP terdekat dari A) supaya JB yang dipilih searah.
    const pop = popAcuanB();
    if (pop) {
      L.polyline([p.A, pop], { color: '#7c3aed', weight: 2, dashArray: '2 8', interactive: false }).addTo(lapisan);
      if (!pop.dipilih) markerSaranPOP(pop);
    }
    kandidatB().forEach(markerKandidatB);
  }
  // JB yang dilepas user selalu ditampilkan (kotak putih) supaya bisa dipakai lagi.
  for (const k of p.jbDilepas || []) {
    const [nama, lat, lng] = k.split('|');
    markerJBLepas({ nama, lat: Number(lat), lng: Number(lng), kunci: k });
  }
  r.jbReferensi.forEach((j) => markerJB(j, false));
  r.jbTracing.forEach((j) => markerJB(j, true));
  const tiangDiKlik = opsiEfektif(p).modeTiang === 'klik';
  // Tiang otomatis tiap 50 m jadi rapat sekali kalau peta jauh; tampilkan saat zoom dekat saja.
  const tampilTiang = tiangDiKlik || map.getZoom() >= ZOOM_TIANG;
  const n = r.tiang.length;
  garisJalur('BPOP', jalurBPOP(p), `B→POP tracing: ${angka(r.panjangBPOP)} m`);
  garisJalur('AB', jalurAB(p), `A→B tarikan baru: ${angka(r.panjangAB)} m · ${n} tiang${tampilTiang ? '' : ' (zoom dekat untuk lihat tiang)'}`);

  if (!tiangDiKlik) p.viaAB.forEach((_, i) => markerVia('AB', i));
  p.viaBPOP.forEach((_, i) => markerVia('BPOP', i));

  r.tiang.forEach((t, k) => {
    if (!tampilTiang) return;
    const diVia = tiangDiKlik && k < p.viaAB.length; // di mode klik, tiang = titik belok (bisa digeser)
    const m = L.marker(t, { icon: ikonTiang(t), draggable: diVia, zIndexOffset: 500 }).addTo(lapisan);
    m.bindTooltip(`Tiang ${t.no}${t.baru ? ' (baru)' : ''}`);
    m.bindPopup(() => popupTiang(t, n));
    if (diVia) {
      m.on('dragend', (e) => { p.viaAB[k] = ll(e.target.getLatLng()); ubah({ rute: true }); });
      m.on('contextmenu', () => { p.viaAB.splice(k, 1); ubah({ rute: true }); });
    }
  });

  for (const key of ['A', 'B', 'POP']) {
    if (!p[key]) continue;
    const m = L.marker(p[key], { icon: ikonPin(key), draggable: true, zIndexOffset: 1000 }).addTo(lapisan);
    m.bindTooltip(namaTitik(key));
    m.on('dragend', (e) => { aturTitik(key, ll(e.target.getLatLng())); ubah({ rute: true }); });
  }
}

const HINT = {
  A: 'Klik peta untuk menaruh titik A (pelanggan).',
  B: 'Klik peta untuk menaruh titik B (titik sambung ke kabel existing).',
  POP: 'Klik peta untuk menaruh POP.',
  BPOP: 'Klik peta untuk menambah titik belok B→POP, atau tarik garis biru ke jalan yang diinginkan. Geser titik belok untuk menyesuaikan, klik kanan untuk hapus.',
};
const hintAB = () => (opsiEfektif(p).modeTiang === 'klik'
  ? 'Klik peta di posisi tiap tiang, urut dari A ke B (B otomatis jadi tiang terakhir). Tarik garis merah untuk menyisipkan, klik kanan tiang untuk hapus.'
  : `Klik peta untuk menambah titik belok A→B, atau tarik garis merah ke jalan yang diinginkan. Geser titik belok untuk menyesuaikan, klik kanan untuk hapus. Tiang otomatis tiap ${p.opsi.jarakTiang} m.`);

function setTool(t) {
  tool = t;
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('#peta').classList.toggle('alat', !!t);
  const hint = $('#hint');
  hint.hidden = !t;
  hint.textContent = t ? `${t === 'AB' ? hintAB() : HINT[t]} — Esc untuk selesai.` : '';
}

map.on('zoomend', () => renderPeta(hitungProject(p).r));

map.on('click', (e) => {
  if (!tool || tarikBaruSaja) return;
  const pt = ll(e.latlng);
  if (tool === 'A' || tool === 'B' || tool === 'POP') {
    aturTitik(tool, pt);
    // Lanjut otomatis A -> B. POP biasanya dipilih dari daftar, jadi berhenti di situ.
    // Setelah A: pilih B dari JB sekitar A (lingkaran radius). Setelah B: pilih POP dari daftar.
    setTool(null);
    if (cariB) lihatRadiusB();
    else if (!p.POP) $('#pilihPOP').focus();
  } else if (tool === 'AB') {
    if (!p.A || !p.B) return toast('Tentukan titik A dan B dulu.');
    p.viaAB.push(pt);
  } else if (tool === 'BPOP') {
    if (!p.B || !p.POP) return toast('Tentukan titik B dan POP dulu.');
    p.viaBPOP.push(pt);
  }
  ubah({ rute: true });
});

function fitView() {
  const semua = [p.A, p.B, p.POP, ...p.viaAB, ...p.viaBPOP].filter(Boolean);
  if (semua.length > 1) map.fitBounds(L.latLngBounds(semua), { padding: [60, 60], maxZoom: 18 });
  else if (semua.length === 1) map.setView(semua[0], 17);
  else map.setView(PUSAT, 14);
}

// ---------------------------------------------------------------- panel

function renderForm() {
  $('#pilihProject').innerHTML = db.projects.map((pr) => `<option value="${pr.id}">${esc(pr.nama)}</option>`).join('');
  $('#pilihProject').value = p.id;
  $('#fNama').value = p.nama;
  $('#fPelanggan').value = p.pelanggan;
  $('#fPO').value = p.noPO;
  $$('[data-mode]').forEach((s) => { s.value = p[`mode${s.dataset.mode}`]; });
  $$('[data-opsi]').forEach((el) => {
    const v = p.opsi[el.dataset.opsi];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

const fmtJarak = (m) => (m < 1000 ? `${angka(m)} m` : `${(m / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} km`);

let kunciDaftarPOP = '';
/** Daftar POP selalu urut dari yang terdekat: ke B, kalau belum ada ke A, kalau belum ada juga ke tengah peta. */
function renderPOP() {
  const [acuan, dari] = p.B ? [p.B, 'B'] : p.A ? [p.A, 'A'] : [ll(map.getCenter()), 'tengah peta'];
  const terpilih = p.POP ? DAFTAR_POP.findIndex((x) => x.nama === p.popNama && x.lat === p.POP.lat && x.lng === p.POP.lng) : -1;
  const kunci = JSON.stringify([acuan, terpilih, !!p.POP]);
  if (kunci === kunciDaftarPOP) return;
  kunciDaftarPOP = kunci;
  const urut = DAFTAR_POP.map((x, i) => ({ ...x, i, d: jarak(acuan, x) })).sort((a, b) => a.d - b.d);
  const judul = p.POP && terpilih < 0 ? 'POP manual (klik peta / koordinat)' : `— Pilih POP (terdekat dari ${dari}) —`;
  $('#pilihPOP').innerHTML = `<option value="">${judul}</option>`
    + urut.map((x) => `<option value="${x.i}">${fmtJarak(x.d)} — ${esc(x.nama)}</option>`).join('');
  $('#pilihPOP').value = terpilih >= 0 ? String(terpilih) : '';
}

let kunciDaftarJB = '';
/** Panel "Pilih B dari JB sekitar A": radius + daftar JB urut terdekat ke A. */
function renderCariB() {
  const km = Number(p.opsi.radiusCariB) || 5;
  $('#btnCariB').classList.toggle('active', cariB);
  $('#btnCariB').textContent = cariB ? 'Tutup pilihan JB' : 'Pilih B dari JB sekitar A';
  $('#panelCariB').hidden = !cariB;
  $('#radiusCariB').value = km;
  $('#labelRadiusB').textContent = `${km.toLocaleString('id-ID')} km`;
  if (!cariB) return;
  const pop = popAcuanB();
  const kunci = JSON.stringify([p.A, km, pop && [pop.lat, pop.lng, !!pop.dipilih]]);
  if (kunci === kunciDaftarJB) return;
  kunciDaftarJB = kunci;
  $('#arahPOP').innerHTML = !pop ? '' : pop.dipilih
    ? `Arah POP: <b>${esc(pop.nama)}</b> (${fmtJarak(pop.jarak)} dari A, dipilih)`
    : `POP terdekat: <b>${esc(pop.nama)}</b> (${fmtJarak(pop.jarak)} dari A) <button data-aksi="pakai-pop">Pakai POP ini</button>`;
  const daftar = kandidatB();
  const searah = daftar.filter((j) => j.searah !== false).length;
  const kmTeks = km.toLocaleString('id-ID');
  const judul = !daftar.length ? `Tidak ada JB dalam ${kmTeks} km, perbesar radius`
    : pop ? `— Pilih JB (${searah} searah, ${daftar.length - searah} menjauh, dalam ${kmTeks} km) —`
      : `— Pilih JB (${daftar.length} dalam ${kmTeks} km) —`;
  $('#pilihJB').innerHTML = `<option value="">${judul}</option>`
    + daftar.map((j) => `<option value="${j.idx}">${fmtJarak(j.jarak)} — ${esc(j.nama)}${j.keP == null ? '' : ` · ${esc(teksArah(j))}`}</option>`).join('');
}

function renderKoord() {
  renderPOP();
  renderCariB();
  $$('.koord').forEach((inp) => { if (document.activeElement !== inp) inp.value = fmtKoord(p[inp.dataset.titik]); });
  $$('.gmaps').forEach((a) => {
    const t = p[a.dataset.titik];
    a.hidden = !t;
    if (t) a.href = linkGmaps(t);
  });
  const efektif = opsiEfektif(p).modeTiang;
  const sel = $('[data-opsi="modeTiang"]');
  sel.disabled = p.modeAB === 'jalan';
  sel.value = efektif;
  sel.title = sel.disabled ? 'Jalur ikut jalan: tiang selalu otomatis' : '';
  $('[data-opsi="jarakTiang"]').disabled = efektif === 'klik';
}

function renderRingkasan(r, rab) {
  const el = $('#ringkasan');
  if (!p.A || !p.B) {
    el.innerHTML = `<h2>Mulai</h2><ol>
      <li>Klik <b>A Pelanggan</b>, lalu klik lokasi pelanggan di peta (atau tempel koordinat).</li>
      <li>Klik peta lagi untuk titik <b>B</b> (sambung ke kabel existing), lalu <b>POP</b>.</li>
      <li>Klik <b>+ Titik / tiang</b> di jalur A→B, lalu klik posisi tiang di peta.</li>
      <li>Buka tab <b>RAB</b> untuk melihat dan mengekspor estimasi.</li></ol>`;
    return;
  }
  // Garis lurus dari A / B ke jalan terdekat yang boleh dilewati (bagian awal & akhir rute).
  const sambung = ruteValid(p, 'AB', titikAB(p))
    ? { A: jarak(p.ruteAB[0], p.ruteAB[1]), B: jarak(p.ruteAB[p.ruteAB.length - 2], p.ruteAB[p.ruteAB.length - 1]) }
    : null;
  const jauh = sambung && Math.max(sambung.A, sambung.B) > 200;
  const rute = p.POP
    ? `https://www.google.com/maps/dir/?api=1&origin=${p.A.lat},${p.A.lng}&destination=${p.POP.lat},${p.POP.lng}&waypoints=${p.B.lat},${p.B.lng}&travelmode=walking`
    : `https://www.google.com/maps/dir/?api=1&origin=${p.A.lat},${p.A.lng}&destination=${p.B.lat},${p.B.lng}&travelmode=walking`;
  el.innerHTML = `<h2>Ringkasan</h2>
    <dl>
      <dt><span class="garis"></span>A→B tarikan baru</dt><dd>${angka(r.panjangAB)} m</dd>
      <dt>A→B garis lurus (pembanding)</dt><dd>${angka(jarak(p.A, p.B))} m</dd>
      ${sambung ? `<dt title="Garis lurus dari A dan B ke jalan terdekat yang boleh dilewati">Lurus ke jalan (A / B)</dt><dd>${angka(sambung.A)} / ${angka(sambung.B)} m</dd>` : ''}
      <dt><span class="garis garis-BPOP"></span>B→POP tracing</dt><dd>${p.POP ? angka(r.panjangBPOP) + ' m' : '—'}</dd>
      ${sumberJalan ? `<dt>Data jalan dari</dt><dd>${esc(sumberJalan)}</dd>` : ''}
      ${p.POP ? `<dt title="JB sejauh ≤ ${p.opsi.radiusJB} m dari jalur B→POP">JB dilewati B→POP</dt><dd>${r.jbTracing.length}</dd>` : ''}
      ${p.jbDilepas?.length ? `<dt title="Klik kotak JB putih di peta untuk memakai lagi">JB dilepas (tidak dilewati)</dt><dd>${p.jbDilepas.length}</dd>` : ''}
      <dt title="JB dilewati + ${p.opsi.core} di user + spare ${p.opsi.spareTracing}">Tracing core (JB + user + spare)</dt><dd>${jumlahTracing(r, p.opsi)}</dd>
      <dt title="${p.opsi.core} di ODF user + ${coreKabel(r, p.opsi)} core di JB tapping dan tiap JB haspel">Jointing (user + ${coreKabel(r, p.opsi)} core × JB)</dt><dd>${jumlahJointing(r, p.opsi)}</dd>
      ${p.B && p.POP ? `<dt>Joint Box di B</dt><dd>${p.bNama ? 'pakai JB existing' : 'JB baru'}</dd>` : ''}
      <dt title="Garis lurus A ke kota Pontianak > ${p.opsi.batasTransportKm} km = wajib Trans ADSS >120 km">Transport ADSS (±${angka(r.jarakPontianak / 1000)} km dari Pontianak)</dt><dd>${perluTransport(r, p.opsi) ? 'ya' : 'tidak'}</dd>
      ${r.jbHaspel ? `<dt title="1 haspel = ${angka(p.opsi.panjangHaspel)} m, tiap sambungan wajib JB">JB sambungan haspel A→B</dt><dd>${r.jbHaspel}</dd>` : ''}
      <dt title="Di bawah 200 m jadi 500 m; 700–1000 m +200 m; lainnya +450 m">Kabel ADSS ${pakaiKabel24(r, p.opsi) ? '24' : '6'} core${p.opsi.spareKabel === false ? '' : ' (+spare)'}</dt><dd>${angka(r.kabel)} m</dd>
      <dt>Tiang${opsiEfektif(p).modeTiang === 'otomatis' ? ` (tiap ${p.opsi.jarakTiang} m)` : ''}</dt><dd>${r.tiang.length}</dd>
      <dt>Tiang baru</dt><dd>${r.tiangBaru}</dd>
    </dl>
    ${jauh ? `<p class="peringatan">Titik ${sambung.A > 200 ? 'A' : 'B'} jauh dari jalan yang dipilih, jadi ada garis lurus ${angka(Math.max(sambung.A, sambung.B))} m memotong blok. Tarik garis merah mengikuti jalan masuk ke lokasi, atau ganti "Jalan yang dipakai".</p>` : ''}
    <div class="total"><span>Total RAB</span><b>${rupiah(totalRAB(rab))}</b></div>
    <a href="${rute}" target="_blank" rel="noopener">Lihat rute di Google Maps</a>`;
}

function renderRAB(rab) {
  const fokus = document.activeElement?.dataset?.id ? [document.activeElement.dataset.id, document.activeElement.dataset.f] : null;
  const tampilNol = $('#tampilNol').checked;
  let bagian = '';
  let html = '';
  for (const b of rab) {
    if (!(b.volume > 0 || b.diubah || tampilNol)) continue;
    if (b.bagian !== bagian) {
      bagian = b.bagian;
      html += `<tr class="grup"><td colspan="5">${esc(BAGIAN[bagian])}</td></tr>`;
    }
    const u = p.ubahRAB[b.id] || {};
    html += `<tr class="${b.volume > 0 ? '' : 'nol'}">
      <td><div>${esc(b.uraian)}</div><div class="kode">${esc(b.kode || 'tanpa kode')} · ${esc(b.satuan)}${u.volume != null ? ` · otomatis ${angka(b.volumeAuto)}` : ''}</div></td>
      <td class="vol"><input type="number" min="0" step="any" data-id="${b.id}" data-f="volume" value="${b.volume}" class="${u.volume != null ? 'ubah' : ''}"></td>
      <td class="hrg"><input type="number" min="0" step="1" data-id="${b.id}" data-f="harga" value="${b.harga}" class="${u.harga != null ? 'ubah' : ''}"></td>
      <td class="jml">${angka(b.jumlah)}</td>
      <td>${b.diubah ? `<button class="mini" data-reset-rab="${b.id}" title="Kembali ke nilai otomatis">↺</button>` : ''}</td>
    </tr>`;
  }
  $('#tabelRAB tbody').innerHTML = html || '<tr><td colspan="5" class="kosong">Belum ada item. Gambar jalur A→B dulu di tab Jalur.</td></tr>';
  const { jasa, material, total } = subtotalRAB(rab);
  $('#tabelRAB tfoot').innerHTML = `
    <tr class="sub"><td colspan="3">RAB JASA Only (A+B+C)</td><td class="jml">${angka(jasa)}</td><td></td></tr>
    <tr class="sub"><td colspan="3">RAB Material (D)</td><td class="jml">${angka(material)}</td><td></td></tr>
    <tr><td colspan="3">TOTAL RAB</td><td class="jml">${angka(total)}</td><td></td></tr>`;
  $('#tabTotal').textContent = total ? `· ${rupiah(total)}` : '';
  if (fokus) $(`#tabelRAB input[data-id="${fokus[0]}"][data-f="${fokus[1]}"]`)?.focus();
}

function renderSemua() {
  const { r, rab } = hitungProject(p);
  // Ubahan per tiang dibuang begitu jumlah tiang berubah, supaya tidak muncul lagi saat jumlahnya kembali sama.
  if (p.ubahTiang && p.ubahTiang.n !== r.tiang.length) p.ubahTiang = null;
  renderPeta(r);
  renderKoord();
  renderRingkasan(r, rab);
  renderRAB(rab);
}

let timerToast = 0;
function toast(pesan, lama = 5000) {
  const el = $('#toast');
  el.textContent = pesan;
  el.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { el.hidden = true; }, lama);
}

function status(pesan) {
  $('#status').textContent = pesan;
  $('#status').hidden = !pesan;
}

function gantiProject(pr) {
  p = pr;
  cariB = false;
  setTool(null);
  simpan();
  renderForm();
  renderSemua();
  fitView();
  perbaruiRute();
}

// ---------------------------------------------------------------- ekspor

function unduh(namaFile, isi, tipe) {
  const url = URL.createObjectURL(new Blob([isi], { type: tipe }));
  const a = Object.assign(document.createElement('a'), { href: url, download: namaFile });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const namaFile = (s) => String(s || 'project').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'project';

function namaSheet(s, dipakai) {
  const dasar = String(s || 'Project').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Project';
  let nama = dasar;
  for (let i = 2; dipakai.has(nama.toLowerCase()); i++) nama = `${dasar} ${i}`;
  dipakai.add(nama.toLowerCase());
  return nama;
}

/** Sheet RAB format form SBU Kalimantan: semua item A–D, subtotal "RAB JASA Only", "RAB Material", "TOTAL RAB". */
function sheetRAB(pr) {
  const { r, rab } = hitungProject(pr);
  const sub = subtotalRAB(rab);
  const info = [
    ['Project', pr.nama],
    ['Pelanggan / lokasi', pr.pelanggan],
    ['No. PO', pr.noPO],
    ['Titik A (pelanggan)', fmtKoord(pr.A)],
    ['Titik B (titik sambung)', [pr.bNama, fmtKoord(pr.B)].filter(Boolean).join(' — ')],
    ['POP', [pr.popNama, fmtKoord(pr.POP)].filter(Boolean).join(' — ')],
    ['Panjang A→B tarikan baru (m)', Math.round(r.panjangAB)],
    ['Panjang B→POP tracing (m)', Math.round(r.panjangBPOP)],
    [`Kabel ADSS ${pakaiKabel24(r, pr.opsi) ? '24' : '6'} core (m${pr.opsi.spareKabel === false ? '' : ', termasuk spare'})`, r.kabel],
    ['Tiang', `${r.tiang.length} (baru ${r.tiangBaru})`],
    ['Tracing core', `${jumlahTracing(r, pr.opsi)} (${r.jbTracing.length} JB + ${pr.opsi.core} user + ${pr.opsi.spareTracing} spare)`],
    ['Jointing per core', `${jumlahJointing(r, pr.opsi)} (${pr.opsi.core} di ODF user + ${coreKabel(r, pr.opsi)} core × ${(r.panjangBPOP > 0 ? 1 : 0) + r.jbHaspel} JB)`],
    ['Transport ADSS', `${perluTransport(r, pr.opsi) ? 'ya' : 'tidak'} (±${Math.round(r.jarakPontianak / 1000)} km garis lurus dari Pontianak)`],
    ['JB dilewati B→POP (tracing)', r.jbTracing.map((j) => j.nama).join(', ') || '-'],
    [`JB sambungan haspel A→B (tiap ${pr.opsi.panjangHaspel} m)`, r.jbHaspel],
  ];
  // Kolom A dipakai nomor tabel, jadi label info ditaruh di kolom B.
  const rows = [['', 'RAB JALUR KABEL'], ...info.map(([label, nilai]) => ['', label, nilai]), [],
    ['No.', 'Pekerjaan', 'Satuan', 'Service Master SBU Kalimantan', 'Harga Satuan', 'Jumlah', 'Harga Total']];
  const itemBaris = [];
  const rentang = {};
  const barisSub = {};
  for (const bagian of Object.keys(BAGIAN)) {
    rows.push([`${bagian}.`, BAGIAN[bagian].slice(3)]);
    const awal = rows.length + 1;
    for (const b of rab.filter((x) => x.bagian === bagian)) {
      rows.push([b.no, b.uraian, b.satuan, b.kode || '-', b.harga, b.volume || null, null]);
      itemBaris.push([rows.length, b]);
    }
    rentang[bagian] = `G${awal}:G${rows.length}`;
    if (bagian === 'C') {
      rows.push(['', 'RAB JASA Only']);
      barisSub.jasa = rows.length;
    }
  }
  rows.push(['', 'RAB Material']);
  barisSub.material = rows.length;
  rows.push(['', 'TOTAL RAB']);
  barisSub.total = rows.length;

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const rp = '"Rp"#,##0;-"Rp"#,##0;"Rp-"';
  const bulat = Number(pr.opsi.pembulatan) || 1;
  for (const [n, b] of itemBaris) {
    ws[`E${n}`].z = rp;
    if (ws[`F${n}`]) ws[`F${n}`].z = '#,##0';
    // Harga total dibulatkan ke atas sama seperti di aplikasi.
    ws[`G${n}`] = { t: 'n', f: bulat > 1 ? `CEILING(E${n}*F${n},${bulat})` : `E${n}*F${n}`, v: b.jumlah, z: rp };
  }
  ws[`G${barisSub.jasa}`] = { t: 'n', f: `SUM(${rentang.A})+SUM(${rentang.B})+SUM(${rentang.C})`, v: sub.jasa, z: rp };
  ws[`G${barisSub.material}`] = { t: 'n', f: `SUM(${rentang.D})`, v: sub.material, z: rp };
  ws[`G${barisSub.total}`] = { t: 'n', f: `G${barisSub.jasa}+G${barisSub.material}`, v: sub.total, z: rp };
  ws['!cols'] = [{ wch: 5 }, { wch: 44 }, { wch: 8 }, { wch: 14 }, { wch: 15 }, { wch: 9 }, { wch: 16 }];
  return { ws, r, rab, sub };
}

function sheetTiang(r) {
  // Jumlah fitting deadend/suspension di RAB dihitung dari tracing, jadi jenis per tiang tidak dicantumkan.
  const rows = [['NO', 'STATUS', 'LAT', 'LNG'], ...r.tiang.map((t) => [t.no, t.baru ? 'Baru' : 'Existing', t.lat, t.lng])];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
  return ws;
}

function sheetJB(r) {
  const rows = [['NO', 'NAMA JB', 'LAT', 'LNG', 'JARAK KE JALUR (m)', 'POSISI DARI B (m)'],
    ...r.jbTracing.map((j, i) => [i + 1, j.nama, j.lat, j.lng, Math.round(j.jarak), Math.round(j.posisi)])];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 17 }];
  return ws;
}

function pastikanXLSX() {
  if (window.XLSX) return true;
  toast('Library Excel belum termuat — cek koneksi internet lalu muat ulang halaman.');
  return false;
}

function eksporExcel() {
  if (!pastikanXLSX()) return;
  const wb = XLSX.utils.book_new();
  const { ws, r } = sheetRAB(p);
  XLSX.utils.book_append_sheet(wb, ws, 'RAB');
  XLSX.utils.book_append_sheet(wb, sheetTiang(r), 'Tiang');
  XLSX.utils.book_append_sheet(wb, sheetJB(r), 'JB Tracing');
  XLSX.writeFile(wb, `RAB ${namaFile(p.nama)}.xlsx`);
}

function eksporExcelSemua() {
  if (!pastikanXLSX()) return;
  const wb = XLSX.utils.book_new();
  const dipakai = new Set(['rekap']);
  const rekap = [['NO', 'PROJECT', 'PELANGGAN / LOKASI', 'NO. PO', 'POP', 'A→B (m)', 'B→POP (m)', 'KABEL (m)', 'CORE', 'TIANG', 'JB TRACING',
    'RAB JASA', 'RAB MATERIAL', 'TOTAL RAB']];
  const sheets = db.projects.map((pr, i) => {
    const { ws, r, sub } = sheetRAB(pr);
    rekap.push([i + 1, pr.nama, pr.pelanggan, pr.noPO, pr.popNama || fmtKoord(pr.POP), Math.round(r.panjangAB), Math.round(r.panjangBPOP),
      r.kabel, r.kabel ? (pakaiKabel24(r, pr.opsi) ? 24 : 6) : '', r.tiang.length, r.jbTracing.length, sub.jasa, sub.material, sub.total]);
    return [ws, namaSheet(pr.nama, dipakai)];
  });
  const n = rekap.length;
  rekap.push(['', '', '', '', '', '', '', '', '', '', 'TOTAL', null, null, null]);
  const wsRekap = XLSX.utils.aoa_to_sheet(rekap);
  ['L', 'M', 'N'].forEach((col, k) => {
    for (let i = 2; i <= n; i++) wsRekap[`${col}${i}`].z = '#,##0';
    wsRekap[`${col}${n + 1}`] = { t: 'n', f: `SUM(${col}2:${col}${n})`, v: rekap.slice(1, n).reduce((s, row) => s + row[11 + k], 0), z: '#,##0' };
  });
  wsRekap['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 32 }, { wch: 12 }, { wch: 36 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 6 }, { wch: 7 }, { wch: 10 },
    { wch: 15 }, { wch: 15 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsRekap, 'Rekap');
  sheets.forEach(([ws, nama]) => XLSX.utils.book_append_sheet(wb, ws, nama));
  XLSX.writeFile(wb, 'RAB Jalur Kabel - Semua Project.xlsx');
}

function eksporKML() {
  const { r } = hitungProject(p);
  const k = (t) => `${t.lng},${t.lat},0`;
  const pm = (nama, geom, gaya = '') => `<Placemark><name>${esc(nama)}</name>${gaya}${geom}</Placemark>`;
  const titik = ['A', 'B', 'POP'].filter((x) => p[x]).map((x) => pm(namaTitik(x, false), `<Point><coordinates>${k(p[x])}</coordinates></Point>`)).join('\n');
  const garis = (nama, jalur, warna) => (jalur.length > 1
    ? pm(nama, `<LineString><tessellate>1</tessellate><coordinates>${jalur.map(k).join(' ')}</coordinates></LineString>`,
      `<Style><LineStyle><color>${warna}</color><width>4</width></LineStyle></Style>`)
    : '');
  const tiang = r.tiang.map((t) => pm(`T${t.no} ${t.jenis === 'D' ? 'Deadend' : 'Suspension'}${t.baru ? ' (baru)' : ''}`, `<Point><coordinates>${k(t)}</coordinates></Point>`)).join('\n');
  const jbs = r.jbTracing.map((j) => pm(j.nama, `<Point><coordinates>${k(j)}</coordinates></Point>`)).join('\n');
  const isi = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(p.nama)}</name>
${titik}
${garis('A→B tarikan baru', jalurAB(p), 'ff2626dc')}
${garis('B→POP tracing', jalurBPOP(p), 'ffeb6325')}
<Folder><name>Tiang</name>
${tiang}
</Folder>
<Folder><name>JB tracing B→POP</name>
${jbs}
</Folder></Document></kml>`;
  unduh(`Jalur ${namaFile(p.nama)}.kml`, isi, 'application/vnd.google-earth.kml+xml');
}

function eksporJSON() {
  unduh(`Backup RAB Jalur Kabel ${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ versi: 1, projects: db.projects }, null, 2), 'application/json');
}

async function imporJSON(file) {
  try {
    const d = JSON.parse(await file.text());
    const list = (Array.isArray(d) ? d : d.projects || []).map(rapikan);
    if (!list.length) throw new Error('tidak ada project di file');
    for (const pr of list) {
      const i = db.projects.findIndex((x) => x.id === pr.id);
      if (i >= 0) db.projects[i] = pr;
      else db.projects.push(pr);
    }
    gantiProject(db.projects.find((x) => x.id === list[0].id));
    toast(`${list.length} project diimpor.`);
  } catch (err) {
    toast(`Gagal impor: ${err.message}`);
  }
}

// ---------------------------------------------------------------- cari tempat

let markerCari = null;

function tandaiCari(h) {
  map.setView(h, 18);
  markerCari?.remove();
  const div = document.createElement('div');
  div.className = 'popup-cari';
  div.innerHTML = `<b>${esc(h.nama)}</b><div class="row">${['A', 'B', 'POP'].map((x) => `<button data-jadi="${x}">Jadikan ${x}</button>`).join('')}</div>`;
  div.addEventListener('click', (e) => {
    const x = e.target.dataset.jadi;
    if (!x) return;
    aturTitik(x, { lat: h.lat, lng: h.lng });
    markerCari.remove();
    markerCari = null;
    ubah({ rute: true });
    if (x === 'A' && cariB) lihatRadiusB();
  });
  markerCari = L.marker(h).addTo(map).bindPopup(div).openPopup();
}

$('#cari').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#cariInput').value.trim();
  const daftar = $('#cariHasil');
  daftar.innerHTML = '';
  if (!q) return;
  const k = parseKoord(q);
  if (k && !/[a-z]{3,}/i.test(q.replace(/\(.*\)/, ''))) return tandaiCari({ ...k, nama: fmtKoord(k) });
  try {
    const url = `${NOMINATIM}?format=jsonv2&limit=6&countrycodes=id&accept-language=id&viewbox=108.85,1.10,109.20,0.70&q=${encodeURIComponent(q)}`;
    const hasil = (await (await fetch(url)).json()).map((h) => ({ lat: Number(h.lat), lng: Number(h.lon), nama: h.display_name }));
    daftar.innerHTML = hasil.map((h, i) => `<li data-i="${i}">${esc(h.nama)}</li>`).join('') || '<li class="kosong">Tidak ditemukan</li>';
    daftar.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      daftar.innerHTML = '';
      tandaiCari(hasil[Number(li.dataset.i)]);
    };
  } catch (err) {
    toast(`Pencarian gagal: ${err.message}`);
  }
});

// ---------------------------------------------------------------- event panel

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
}));

$$('.tool').forEach((b) => b.addEventListener('click', () => setTool(tool === b.dataset.tool ? null : b.dataset.tool)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTool(null); });

$('#pilihProject').addEventListener('change', (e) => gantiProject(db.projects.find((x) => x.id === e.target.value)));

$('#btnBaru').addEventListener('click', () => {
  const nama = prompt('Nama project baru:', `Project ${db.projects.length + 1}`);
  if (!nama?.trim()) return;
  const pr = projectBaru(nama.trim());
  db.projects.push(pr);
  gantiProject(pr);
  setTool('A');
});

$('#btnDuplikat').addEventListener('click', () => {
  const pr = { ...structuredClone(p), id: buatId(), nama: `${p.nama} (salinan)`, dibuat: Date.now() };
  db.projects.push(pr);
  gantiProject(pr);
});

$('#btnHapus').addEventListener('click', () => {
  if (!confirm(`Hapus project "${p.nama}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  db.projects = db.projects.filter((x) => x.id !== p.id);
  if (!db.projects.length) db.projects.push(projectBaru('Project 1'));
  gantiProject(db.projects[0]);
});

for (const [id, key] of [['fNama', 'nama'], ['fPelanggan', 'pelanggan'], ['fPO', 'noPO']]) {
  $(`#${id}`).addEventListener('input', (e) => {
    p[key] = e.target.value;
    simpan();
    if (key === 'nama') $('#pilihProject').selectedOptions[0].textContent = p.nama;
  });
}

$$('.koord').forEach((inp) => inp.addEventListener('change', () => {
  const key = inp.dataset.titik;
  if (!inp.value.trim()) {
    aturTitik(key, null);
    return ubah({ rute: true });
  }
  const t = parseKoord(inp.value);
  if (!t) {
    toast('Format koordinat: lat, lng — contoh 0.908456, 109.010200');
    inp.value = fmtKoord(p[key]);
    return;
  }
  aturTitik(key, t);
  ubah({ rute: true });
  if (key === 'A' && cariB) lihatRadiusB();
  else map.setView(t, Math.max(map.getZoom(), 17));
}));

$$('[data-mode]').forEach((s) => s.addEventListener('change', () => {
  p[`mode${s.dataset.mode}`] = s.value;
  ubah({ rute: true });
}));

$$('[data-undo]').forEach((b) => b.addEventListener('click', () => {
  (b.dataset.undo === 'AB' ? p.viaAB : p.viaBPOP).pop();
  ubah({ rute: true });
}));

$$('[data-reset]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.reset;
  if (!(key === 'AB' ? p.viaAB : p.viaBPOP).length || !confirm('Hapus semua titik di jalur ini?')) return;
  if (key === 'AB') p.viaAB = [];
  else p.viaBPOP = [];
  ubah({ rute: true });
}));

$$('[data-opsi]').forEach((el) => el.addEventListener('change', () => {
  const key = el.dataset.opsi;
  p.opsi[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  ubah({ rute: key === 'kelasJalan' });
}));

$('#tampilNol').addEventListener('change', () => renderSemua());

$('#btnCariB').addEventListener('click', () => {
  if (!p.A) return toast('Taruh titik A dulu.');
  cariB = !cariB;
  renderSemua();
  if (cariB) lihatRadiusB();
});

$('#radiusCariB').addEventListener('input', (e) => {
  p.opsi.radiusCariB = Number(e.target.value);
  renderSemua();
});
$('#radiusCariB').addEventListener('change', () => {
  simpan();
  lihatRadiusB();
});

$('#pilihJB').addEventListener('change', (e) => {
  if (e.target.value === '') return;
  const [nama, lat, lng] = DAFTAR_JB[Number(e.target.value)];
  pilihB({ nama, lat, lng });
});

// Belum ada titik A/B: urutan POP mengikuti tengah peta yang sedang dilihat.
map.on('moveend', () => { if (!p.A && !p.B) renderPOP(); });

$('#pilihPOP').addEventListener('change', (e) => {
  if (e.target.value === '') return;
  pakaiPOP(DAFTAR_POP[Number(e.target.value)]);
  fitView();
});

$('#arahPOP').addEventListener('click', (e) => {
  if (e.target.dataset.aksi !== 'pakai-pop') return;
  const pop = popAcuanB();
  if (pop && !pop.dipilih) pakaiPOP(pop);
});

// Pilihan server data jalan & data offline (pengaturan aplikasi, bukan per project).
$('#serverJalan').innerHTML = '<option value="otomatis">Otomatis (proxy lokal + semua server)</option>'
  + SERVER_OVERPASS.map((s) => `<option value="${s.url}">${esc(s.nama)}</option>`).join('')
  + '<option value="sendiri">Server sendiri (mis. Docker)…</option>';
function renderPengaturan() {
  $('#serverJalan').value = pengaturan.server;
  $('#serverSendiri').hidden = pengaturan.server !== 'sendiri';
  $('#serverSendiri').value = pengaturan.serverSendiri;
  $('#pakaiOffline').checked = pengaturan.offline;
}
renderPengaturan();

$('#serverJalan').addEventListener('change', (e) => {
  pengaturan.server = e.target.value;
  simpanPengaturan();
  renderPengaturan();
  perbaruiRute();
});
$('#serverSendiri').addEventListener('change', (e) => {
  pengaturan.serverSendiri = e.target.value.trim();
  simpanPengaturan();
  perbaruiRute();
});
$('#pakaiOffline').addEventListener('change', (e) => {
  pengaturan.offline = e.target.checked;
  simpanPengaturan();
  cacheGraf.clear();
  for (const key of ['AB', 'BPOP']) p[`kunci${key}`] = '';
  ubah({ rute: true });
});

$('#btnResetBelok').addEventListener('click', () => {
  const jumlah = p.viaAB.length + p.viaBPOP.length;
  if (!jumlah) return toast('Belum ada titik belok di jalur A→B maupun B→POP.');
  if (!confirm(`Hapus semua ${jumlah} titik belok (A→B: ${p.viaAB.length}, B→POP: ${p.viaBPOP.length})?`)) return;
  p.viaAB = [];
  p.viaBPOP = [];
  ubah({ rute: true });
  toast(`${jumlah} titik belok dihapus.`);
});

$('#btnUlangRute').addEventListener('click', async () => {
  gagalSampai.clear();
  proxyAda = true;
  await hapusCacheJalan(); // ambil data jalan terbaru dari server
  for (const key of ['AB', 'BPOP']) p[`kunci${key}`] = '';
  ubah({ rute: true });
});

$('#tabelRAB').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.id) return;
  const { id, f } = el.dataset;
  const u = (p.ubahRAB[id] ||= {});
  const otomatis = f === 'harga'
    ? KATALOG.find((k) => k.id === id).harga
    : hitungProject(p).rab.find((b) => b.id === id).volumeAuto;
  const v = el.value === '' ? null : Number(el.value);
  if (v == null || v === otomatis) delete u[f];
  else u[f] = v;
  if (!Object.keys(u).length) delete p.ubahRAB[id];
  ubah();
});

$('#tabelRAB').addEventListener('click', (e) => {
  const id = e.target.dataset.resetRab;
  if (!id) return;
  delete p.ubahRAB[id];
  ubah();
});

$('#btnXlsx').addEventListener('click', eksporExcel);
$('#btnXlsxSemua').addEventListener('click', eksporExcelSemua);
$('#btnKml').addEventListener('click', eksporKML);
$('#btnJson').addEventListener('click', eksporJSON);
$('#fileJson').addEventListener('change', (e) => {
  if (e.target.files[0]) imporJSON(e.target.files[0]);
  e.target.value = '';
});

// ---------------------------------------------------------------- mulai

renderForm();
renderSemua();
fitView();
perbaruiRute();
