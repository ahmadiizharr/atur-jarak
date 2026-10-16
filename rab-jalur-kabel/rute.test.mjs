// Jalankan: node --test rute.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunGraf, ruteMelalui, bboxUntuk, bboxBerisi, queryOverpass, grafOffline } from './rute.js';
import { panjang } from './hitung.js';

// Jalan besar berbentuk U: 1 →(timur) 2 →(utara) 3 →(barat) 4. Tidak ada jalan 1-4 (anggap itu gang).
// Way 20 = potongan jalan terputus di dekat jalan 1-2.
const osm = {
  elements: [
    { type: 'node', id: 1, lat: 0, lon: 0 },
    { type: 'node', id: 2, lat: 0, lon: 0.002 },
    { type: 'node', id: 3, lat: 0.002, lon: 0.002 },
    { type: 'node', id: 4, lat: 0.002, lon: 0 },
    { type: 'node', id: 10, lat: -0.00005, lon: 0.0005 },
    { type: 'node', id: 11, lat: -0.00005, lon: 0.0007 },
    { type: 'way', id: 100, nodes: [1, 2, 3, 4] },
    { type: 'way', id: 20, nodes: [10, 11] },
  ],
};
const graf = bangunGraf(osm);
const M = 111195; // meter per derajat di khatulistiwa

test('rute memutar lewat jalan besar, tidak memotong lewat gang', () => {
  const P = { lat: -0.0001, lng: 0 };
  const Q = { lat: 0.0021, lng: 0 };
  const { titik } = ruteMelalui(graf, [P, Q]);
  const L = panjang(titik);
  assert.ok(Math.abs(L - (0.0001 + 0.002 * 3 + 0.0001) * M) < 2, `panjang ${L}`);
  assert.ok(titik.some((t) => t.lat === 0 && t.lng === 0.002), 'lewat node 2');
  assert.ok(titik.some((t) => t.lat === 0.002 && t.lng === 0.002), 'lewat node 3');
});

test('potongan jalan terputus tidak dipakai sebagai titik masuk', () => {
  const P = { lat: -0.0001, lng: 0.0006 }; // lebih dekat ke way 20 daripada ke jalan 1-2
  const Q = { lat: 0.0021, lng: 0 };
  const { titik } = ruteMelalui(graf, [P, Q]);
  assert.equal(titik[1].lat, 0, 'masuk ke jalan 1-2, bukan way 20');
});

test('dua titik di sisi jalan yang sama: lurus sepanjang jalan itu', () => {
  const P = { lat: -0.0001, lng: 0.0005 };
  const Q = { lat: -0.0001, lng: 0.0015 };
  const L = panjang(ruteMelalui(graf, [P, Q]).titik);
  assert.ok(Math.abs(L - (0.0001 + 0.001 + 0.0001) * M) < 2, `panjang ${L}`);
});

test('titik belok: rute lewat titik belok, legAwal menunjuk awal tiap leg', () => {
  const P = { lat: -0.0001, lng: 0 };
  const V = { lat: 0.001, lng: 0.0021 };
  const Q = { lat: 0.0021, lng: 0 };
  const { titik, legAwal } = ruteMelalui(graf, [P, V, Q]);
  assert.equal(legAwal.length, 2);
  assert.equal(legAwal[0], 0);
  assert.deepEqual(titik[legAwal[1]], V);
  assert.deepEqual(titik[0], P);
  assert.deepEqual(titik[titik.length - 1], Q);
});

test('area tanpa jalan -> error yang jelas', () => {
  assert.throws(() => ruteMelalui(bangunGraf({ elements: [] }), [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]), /tidak ada jalan/);
});

// Data offline: way 0 = tertiary (indeks 4) 1→2→3→4 berbentuk U, way 1 = unclassified (5) jalan pintas 1→4.
const offline = {
  bbox: { s: -1, w: -1, n: 1, e: 1 },
  kelas: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'],
  nodes: [0, 0, 0, 200, 200, 200, 200, 0], // lat/lng x 1e5: (0,0) (0,.002) (.002,.002) (.002,0)
  ways: [[4, 0, 1, 2, 3], [5, 0, 3]],
};

test('data jalan offline: kelas "besar" tidak memakai jalan unclassified', () => {
  const area = { s: -0.01, w: -0.01, n: 0.01, e: 0.01 };
  const P = { lat: -0.0001, lng: 0 };
  const Q = { lat: 0.0021, lng: 0 };
  const besar = panjang(ruteMelalui(grafOffline(offline, area, 'besar'), [P, Q]).titik);
  const sedang = panjang(ruteMelalui(grafOffline(offline, area, 'sedang'), [P, Q]).titik);
  assert.ok(Math.abs(besar - 0.0062 * M) < 2, `besar memutar: ${besar}`);
  assert.ok(Math.abs(sedang - 0.0022 * M) < 2, `sedang lewat jalan pintas: ${sedang}`);
});

test('data jalan offline: di luar area file atau kelas tidak tersedia -> null (pakai server)', () => {
  assert.equal(grafOffline(offline, { s: 2, w: 2, n: 3, e: 3 }, 'besar'), null);
  assert.equal(grafOffline(offline, { s: -0.01, w: -0.01, n: 0.01, e: 0.01 }, 'lingkungan'), null);
  assert.equal(grafOffline(null, { s: 0, w: 0, n: 0, e: 0 }, 'besar'), null);
  // Area ambil melebar keluar file, tapi titik rute (wajib) di dalam -> tetap pakai data offline.
  const lebar = { s: -1.5, w: -1.5, n: 0.01, e: 0.01 };
  assert.ok(grafOffline(offline, lebar, 'besar', { s: -0.01, w: -0.01, n: 0.01, e: 0.01 }).edges.length > 0);
});

test('titik belok user di jalan kecil diprioritaskan: leg-nya lewat jalan kecil, bukan lompat dari jalan besar', () => {
  const area = { s: -0.01, w: -0.01, n: 0.01, e: 0.01 };
  const besar = grafOffline(offline, area, 'besar'); // hanya jalan U (tersier)
  const bebas = grafOffline(offline, area, 'sedang'); // + jalan kecil pintas 1-4
  const P = { lat: -0.0001, lng: 0 };
  const V = { lat: 0.001, lng: 0.00002 }; // titik belok user, 2 m dari jalan kecil, 111 m dari jalan besar
  const Q = { lat: 0.0021, lng: 0 };
  // Tanpa prioritas: titik belok dicapai dengan lompatan lurus 111 m dari jalan besar.
  const lama = ruteMelalui(besar, [P, V, Q]).titik;
  assert.ok(lama.some((t) => t.lat === 0 && t.lng === 0.002), 'rute lama memutar lewat jalan besar');
  // Dengan prioritas titik user: lewat jalan kecil, tidak menyentuh jalan U di sisi timur.
  const baru = ruteMelalui(besar, [P, V, Q], { grafBebas: bebas, wajib: new Set([1]) }).titik;
  assert.ok(!baru.some((t) => t.lng === 0.002), 'tidak lewat sisi timur jalan U');
  assert.ok(panjang(baru) < 0.0025 * M, `panjang ${panjang(baru)}`);
  // Titik B/POP biasa (bukan titik user) tetap pakai jalan besar.
  const tanpaWajib = ruteMelalui(besar, [P, V, Q], { grafBebas: bebas }).titik;
  assert.deepEqual(tanpaWajib, lama);
});

test('titik belok user yang ada di jalan besar: rute tidak berubah', () => {
  const area = { s: -0.01, w: -0.01, n: 0.01, e: 0.01 };
  const besar = grafOffline(offline, area, 'besar');
  const bebas = grafOffline(offline, area, 'sedang');
  const P = { lat: -0.0001, lng: 0 };
  const V = { lat: 0.00001, lng: 0.0015 }; // di jalan besar (1 m)
  const Q = { lat: 0.0021, lng: 0 };
  assert.deepEqual(ruteMelalui(besar, [P, V, Q], { grafBebas: bebas, wajib: new Set([1]) }).titik, ruteMelalui(besar, [P, V, Q]).titik);
});

test('banyak titik belok di jalan yang tidak ada di data (mis. jalan servis): lurus antar titik, tanpa tusukan', () => {
  const area = { s: -0.01, w: -0.01, n: 0.01, e: 0.01 };
  const besar = grafOffline(offline, area, 'besar');
  const bebas = grafOffline(offline, area, 'sedang');
  // B di barat, titik belok berderet ke selatan di "jalan servis" 100 m barat jalan pintas (lng -0.0009), POP di timur.
  const B = { lat: 0.0022, lng: -0.0009 };
  const V = [0.0018, 0.0014, 0.001, 0.0006].map((lat) => ({ lat, lng: -0.0009 }));
  const POP = { lat: 0.0021, lng: 0.0021 };
  const titik = [B, ...V, POP];
  const { titik: rute } = ruteMelalui(besar, titik, { grafBebas: bebas, wajib: new Set([1, 2, 3, 4]), titikUser: new Set([0]) });
  // Ruas B→V1→...→V4 lurus mengikuti titik user (tidak ada titik lain di antaranya).
  const idx = (t) => rute.findIndex((r) => r.lat === t.lat && r.lng === t.lng);
  assert.deepEqual([B, ...V].map(idx), [0, 1, 2, 3, 4]);
  // Leg terakhir ke POP (bukan titik user) tetap lewat jalan.
  assert.ok(rute.length > 6, 'leg ke POP mengikuti jalan');
  // Tanpa prioritas, tiap titik belok ditusuk dari jalan (rute jauh lebih panjang).
  const lama = ruteMelalui(besar, titik).titik;
  assert.ok(panjang(lama) > panjang(rute) + 300, `lama ${panjang(lama)} vs baru ${panjang(rute)}`);
});

test('bbox & query Overpass hanya kelas jalan besar', () => {
  const b = bboxUntuk([{ lat: 0.9, lng: 109 }, { lat: 0.91, lng: 109.02 }]);
  assert.ok(bboxBerisi(b, bboxUntuk([{ lat: 0.905, lng: 109.01 }], 0.001)));
  const q = queryOverpass(b, 'besar');
  assert.match(q, /tertiary/);
  assert.doesNotMatch(q, /residential|service|footway|path/);
});
