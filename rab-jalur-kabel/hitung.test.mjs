// Jalankan: node --test rab-jalur-kabel/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jarak, jenisTiang, ringkasan, hitungRAB, totalRAB, subtotalRAB, opsiDefault, jbDalamRadius, jbDekatJalur, lewatJB,
  bulatkanAtas, terdekat, tandaiArahPOP, kabelDenganSpare,
} from './hitung.js';
import { KATALOG } from './katalog.js';

const M_PER_DERAJAT = jarak({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
// Titik di khatulistiwa sejauh `m` meter ke timur dari (0, 0).
const timur = (m) => ({ lat: 0, lng: m / M_PER_DERAJAT });
const vol = (baris, id) => baris.find((b) => b.id === id).volume;

test('jarak haversine 1 derajat bujur di khatulistiwa', () => {
  assert.ok(Math.abs(M_PER_DERAJAT - 111195) < 1);
});

test('pola tiang: 3 suspension lalu deadend di tiang ke-4, tiang terakhir deadend', () => {
  const pola = (n) => Array.from({ length: n }, (_, k) => jenisTiang(k + 1, n, 4)).join('');
  assert.equal(pola(4), 'SSSD');
  assert.equal(pola(6), 'SSSDSD');
  assert.equal(pola(8), 'SSSDSSSD');
  assert.equal(pola(1), 'D');
});

test('default: A->B 300 m, tiang tiap 50 m = 6 tiang (S S S D S D)', () => {
  const r = ringkasan([timur(0), timur(300)], [], opsiDefault());
  assert.deepEqual(r.tiang.map((t) => t.jenis), ['S', 'S', 'S', 'D', 'S', 'D']);
  assert.equal(r.suspension, 4);
  assert.equal(r.deadend, 2);
});

test('A->B 300 m otomatis tiap 75 m: 4 tiang = 3 suspension + 1 deadend', () => {
  const opsi = { ...opsiDefault(), jarakTiang: 75 };
  const r = ringkasan([timur(0), timur(300)], [], opsi);
  assert.equal(r.tiang.length, 4);
  assert.equal(r.suspension, 3);
  assert.equal(r.deadend, 1);
  assert.equal(r.tiang[3].jenis, 'D');
  assert.equal(r.kabel, 750, 'tarikan 300 m + spare 450 m');
  assert.ok(Math.abs(r.tiang[3].lng - timur(300).lng) < 1e-9, 'tiang terakhir di B');
});

test('mode klik: 3 titik tiang + B = 4 tiang', () => {
  const r = ringkasan([timur(0), timur(80), timur(150), timur(230), timur(300)], [], { ...opsiDefault(), modeTiang: 'klik' });
  assert.deepEqual(r.tiang.map((t) => t.jenis), ['S', 'S', 'S', 'D']);
});

test('ubah tiang manual: jadikan deadend + tandai tiang baru', () => {
  const opsi = { ...opsiDefault(), jarakTiang: 75 };
  const r = ringkasan([timur(0), timur(300)], [], opsi, { 2: { jenis: 'D', baru: true } });
  assert.equal(r.suspension, 2);
  assert.equal(r.deadend, 2);
  assert.equal(r.tiangBaru, 1);
});

const TANPA_BULAT = { ...opsiDefault(), pembulatan: 1 };

test('RAB standar FOC 300 m tanpa POP, harga SBU Kalimantan tanpa pembulatan', () => {
  // Titik tes di (0,0), jauh dari Pontianak -> transport ADSS wajib.
  const baris = hitungRAB(ringkasan([timur(0), timur(300)], [], TANPA_BULAT), TANPA_BULAT);
  const harapan = {
    // kabel 300 m + spare 450 = 750; tracing = 0 JB + 2 user + 5 spare = 7; deadend 7/3 -> 3; suspension 7-3 = 4
    3005193: 1, 3005194: 750, 3005195: 2, 3005196: 7, 3005197: 2, 3005198: 0, 3005199: 7, 3005214: 1, 3005218: 2, 3005220: 1,
    3005222: 3, 3005224: 4, 3005233: 1, 3005231: 0, 3005272: 2, 3005235: 0, 3005288: 0, 3005293: 1,
    D120: 1, D121: 1, D124: 1, D126: 750, D127: 0,
  };
  for (const [id, v] of Object.entries(harapan)) assert.equal(vol(baris, id), v, `volume ${id}`);
  assert.equal(vol(baris, '3005209'), 0, 'instalasi AP tidak otomatis');
  // A: 1.286.162 + 750x3.717 + 2x35.546 + 7x176.580 + 2x19.070 + 7x24.298 + 1.199.284 + 2x880 + 400.002 = 7.190.336
  // B: 3x71.438 + 4x56.232 + 644.776 + 2x45.531 = 1.175.080; C: 736.472
  // D: 72.200 + 66.880 + 1.180.000 + 750x3.310 = 3.801.580
  assert.deepEqual(subtotalRAB(baris), { jasa: 9101888, material: 3801580, total: 12903468 });
  assert.equal(totalRAB(baris), 12903468);
});

test('pembulatan default: harga total tiap item dibulatkan ke atas ke Rp 1.000', () => {
  const baris = hitungRAB(ringkasan([timur(0), timur(300)], [], opsiDefault()), opsiDefault());
  assert.equal(baris.find((b) => b.id === '3005193').jumlah, 1287000, 'survey 1.286.162 -> 1.287.000');
  assert.equal(baris.find((b) => b.id === '3005218').jumlah, 2000, 'labeling in site 1.760 -> 2.000');
  assert.equal(baris.find((b) => b.id === 'D124').jumlah, 1180000, 'sudah kelipatan 1.000 tetap');
  assert.ok(baris.every((b) => b.jumlah % 1000 === 0));
  // A: 1.287.000+2.788.000+72.000+1.237.000+39.000+171.000+1.200.000+2.000+401.000
  // B: 215.000+225.000+645.000+92.000; C: 737.000; D: 73.000+67.000+1.180.000+2.483.000
  assert.deepEqual(subtotalRAB(baris), { jasa: 9111000, material: 3803000, total: 12914000 });
});

test('spare kabel: <200 m jadi 500 m, 700-1000 m +200 m, lainnya +450 m', () => {
  assert.equal(kabelDenganSpare(0), 0);
  assert.equal(kabelDenganSpare(95), 500);
  assert.equal(kabelDenganSpare(199), 500);
  assert.equal(kabelDenganSpare(200), 650);
  assert.equal(kabelDenganSpare(700), 1150);
  assert.equal(kabelDenganSpare(701), 901);
  assert.equal(kabelDenganSpare(999), 1199);
  assert.equal(kabelDenganSpare(1000), 1450);
  assert.equal(ringkasan([timur(0), timur(300)], [], { ...opsiDefault(), spareKabel: false }).kabel, 300);
});

// Titik sekitar Singkawang: `m` meter ke timur, `utara` meter ke utara.
const SKW = { lat: 0.91, lng: 108.99 };
const skw = (m, utara = 0) => ({ lat: SKW.lat + utara / M_PER_DERAJAT, lng: SKW.lng + m / (M_PER_DERAJAT * Math.cos((SKW.lat * Math.PI) / 180)) });
const jbSkw = (nama, m, utara = 0) => { const t = skw(m, utara); return [nama, t.lat, t.lng]; };

test('contoh: A->B 95 m, B = JB existing, B->POP 311 m lewat 5 JB, di Singkawang', () => {
  const daftar = [jbSkw('JB-B', 95), jbSkw('J1', 150, 10), jbSkw('J2', 220, -20), jbSkw('J3', 300, 30), jbSkw('J4', 380, 5), jbSkw('REF', 250, 100)];
  const r = ringkasan([skw(0), skw(95)], [skw(95), skw(406)], opsiDefault(), {}, daftar);
  assert.equal(r.jbTracing.length, 5);
  assert.equal(r.kabel, 500, '95 m di bawah 200 m -> 500 m');
  const baris = hitungRAB(r, opsiDefault(), {}, { bJBExisting: true });
  const harapan = {
    3005194: 500, // penarikan = kabel
    3005196: 12, // tracing = 5 JB + 2 user + 5 spare
    3005199: 12, // labeling kabel = tracing
    3005222: 4, // deadend = 12 / 3
    3005224: 8, // suspension = 12 - 4
    3005195: 8, // jointing = 2 di ODF user + 6 core di JB tapping
    3005198: 1, // labeling JB tapping
    3005235: 0, // B JB existing -> tidak ada Joint Box baru
    3005293: 1, // Singkawang jauh dari Pontianak -> transport ADSS
  };
  for (const [id, v] of Object.entries(harapan)) assert.equal(vol(baris, id), v, `volume ${id}`);
  // Jointing 8 x 35.546 = 284.368 -> 285.000 (dibulatkan)
  assert.deepEqual(subtotalRAB(baris), { jasa: 9707000, material: 2975000, total: 12682000 });
  // B bukan JB existing (ditaruh manual) -> Joint Box baru di B.
  assert.equal(vol(hitungRAB(r, opsiDefault()), '3005235'), 1);
});

test('transport ADSS hanya kalau A jauh dari kota Pontianak', () => {
  const transport = (a) => vol(hitungRAB(ringkasan([a, { lat: a.lat, lng: a.lng + 0.003 }], [], opsiDefault()), opsiDefault()), '3005293');
  assert.equal(transport(skw(0)), 1, 'Singkawang');
  assert.equal(transport({ lat: 1.36, lng: 109.3 }), 1, 'Sambas');
  assert.equal(transport({ lat: -0.03, lng: 109.33 }), 0, 'Pontianak');
  assert.equal(transport({ lat: 0.36, lng: 108.96 }), 0, 'Mempawah (±60 km)');
});

test('bulatkanAtas: kelipatan, nol, dan tanpa pembulatan', () => {
  assert.equal(bulatkanAtas(1286162, 1000), 1287000);
  assert.equal(bulatkanAtas(1286162, 100), 1286200);
  assert.equal(bulatkanAtas(1287000, 1000), 1287000);
  assert.equal(bulatkanAtas(0, 1000), 0);
  assert.equal(bulatkanAtas(1286162, 1), 1286162);
  assert.equal(bulatkanAtas(0.1 * 3 * 1000, 100), 300, 'derau floating point tidak menaikkan pembulatan');
});

test('RAB dengan tracing B->POP tanpa JB terdeteksi, B ditaruh manual: JB baru di B', () => {
  const r = ringkasan([timur(0), timur(300)], [timur(300), timur(1300)], TANPA_BULAT);
  const baris = hitungRAB(r, TANPA_BULAT);
  assert.equal(vol(baris, '3005196'), 7, '0 JB + 2 user + 5 spare');
  assert.equal(vol(baris, '3005235'), 1);
  assert.equal(vol(baris, '3005198'), 1);
  assert.equal(vol(baris, '3005195'), 8, '2 di ODF user + 6 core di JB tapping');
  assert.equal(totalRAB(baris), 12903468 + 622248 + 12800 + 6 * 35546);
});

test('tarikan A->B lebih dari 10 km: kabel ADSS 24 core + ODF 24 core', () => {
  const opsi = opsiDefault();
  const pendek = hitungRAB(ringkasan([timur(0), timur(10000)], [], opsi), opsi);
  assert.equal(vol(pendek, 'D126'), 10450, 'tarikan tepat 10 km masih 6 core (kabel + spare 450)');
  assert.equal(vol(pendek, 'D127'), 0);
  const panjang = hitungRAB(ringkasan([timur(0), timur(10500)], [], opsi), opsi);
  assert.equal(vol(panjang, 'D126'), 0);
  assert.equal(vol(panjang, 'D127'), 10950);
  assert.equal(vol(panjang, '3005233'), 0);
  assert.equal(vol(panjang, '3005231'), 1);
  assert.equal(vol(panjang, '3005235'), 2, '10.950 m = 3 haspel -> 2 sambungan');
});

// JB = [nama, lat, lng]; `utara` meter di utara garis khatulistiwa.
const jb = (nama, m, utara = 0) => [nama, utara / M_PER_DERAJAT, timur(m).lng];

test('tracing = jumlah JB yang dilewati B->POP; JB di A->B tidak dihitung', () => {
  const daftar = [
    jb('JB-AB', 150, 5),        // dekat jalur A->B -> tidak dihitung
    jb('JB-1', 500, 10),        // dilewati B->POP (10 m dari jalur)
    jb('JB-2', 900, -20),       // dilewati B->POP
    jb('JB-REF', 1100, 120),    // 120 m dari jalur -> hanya referensi
    jb('JB-JAUH', 700, 900),    // terlalu jauh -> diabaikan
  ];
  const r = ringkasan([timur(0), timur(300)], [timur(300), timur(1300)], opsiDefault(), {}, daftar);
  assert.deepEqual(r.jbTracing.map((j) => j.nama), ['JB-1', 'JB-2']);
  // JB-AB cuma 150 m dari B, jadi boleh tampil sebagai referensi, tapi tidak dihitung tracing.
  assert.deepEqual(r.jbReferensi.map((j) => j.nama).sort(), ['JB-AB', 'JB-REF']);
  assert.equal(vol(hitungRAB(r, opsiDefault()), '3005196'), 2 + 2 + 5, '2 JB + 2 user + 5 spare');
});

test('ikuti jalur JB: jalur dibelokkan lewat JB dalam 60 m, urut dari B ke POP', () => {
  const dasar = [timur(0), timur(1000)];
  const daftar = [jb('J700', 700, -30), jb('J300', 300, 20), jb('REF', 500, 100)];
  const jbs = jbDekatJalur(dasar, daftar, opsiDefault().radiusJB);
  const lewat = lewatJB(dasar, jbs);
  assert.deepEqual(lewat[0], dasar[0]);
  assert.deepEqual(lewat[lewat.length - 1], dasar[1]);
  assert.deepEqual(lewat.slice(1, -1).map((t) => Math.round(t.lng * M_PER_DERAJAT)), [300, 700]);
  // Setelah dibelokkan, JB itu jarak 0 dari jalur dan dihitung tracing; REF (100 m) tetap referensi abu-abu.
  const r = ringkasan([], lewat, opsiDefault(), {}, daftar);
  assert.deepEqual(r.jbTracing.map((j) => j.nama), ['J300', 'J700']);
  assert.deepEqual(r.jbReferensi.map((j) => j.nama), ['REF']);
  assert.ok(r.jbTracing.every((j) => j.jarak < 0.5));
});

test('ikuti jalur JB tanpa JB di dekat jalur: jalur tidak berubah', () => {
  const dasar = [timur(0), timur(400), timur(1000)];
  assert.equal(lewatJB(dasar, []), dasar);
});

test('POP terdekat + arah JB: JB yang lebih jauh dari POP daripada A ditandai menjauh', () => {
  const A = timur(0);
  const daftarPOP = [{ nama: 'POP-BARAT', ...timur(-3000) }, { nama: 'POP-TIMUR', ...timur(2000) }];
  const pop = terdekat(A, daftarPOP);
  assert.equal(pop.nama, 'POP-TIMUR');
  assert.ok(Math.abs(pop.jarak - 2000) < 1);
  const jbs = jbDalamRadius(A, [jb('KE-TIMUR', 500), jb('KE-BARAT', -400)], 5000);
  const arah = tandaiArahPOP(A, jbs, pop);
  assert.deepEqual(arah.map((j) => [j.nama, j.searah]), [['KE-BARAT', false], ['KE-TIMUR', true]]);
  assert.ok(Math.abs(arah.find((j) => j.nama === 'KE-TIMUR').keP - 1500) < 1);
  assert.equal(terdekat(A, []), null);
});

test('JB kandidat titik B: hanya dalam radius dari A, urut terdekat', () => {
  const daftar = [jb('JAUH', 6000), jb('DEKAT', 800), jb('SEDANG', 3000, 500)];
  const hasil = jbDalamRadius(timur(0), daftar, 5000);
  assert.deepEqual(hasil.map((j) => j.nama), ['DEKAT', 'SEDANG']);
  assert.equal(hasil[0].idx, 1);
  assert.ok(Math.abs(hasil[0].jarak - 800) < 1);
});

test('haspel 4 km: tiap sambungan haspel di A->B tambah 1 JB + labeling + jointing', () => {
  const tanpaSpare = { ...opsiDefault(), spareKabel: false };
  const jbHaspel = (m, opsi = tanpaSpare) => ringkasan([timur(0), timur(m)], [], opsi).jbHaspel;
  assert.equal(jbHaspel(3999), 0);
  assert.equal(jbHaspel(4000), 0);
  assert.equal(jbHaspel(4500), 1);
  assert.equal(jbHaspel(9000), 2);
  assert.equal(jbHaspel(3800, opsiDefault()), 1, '3.800 m + spare 450 = 4.250 m -> 2 haspel');
  const r = ringkasan([timur(0), timur(9000)], [timur(9000), timur(9500)], tanpaSpare);
  const core = tanpaSpare.core;
  const baru = hitungRAB(r, tanpaSpare);
  assert.equal(vol(baru, '3005235'), 3, 'JB baru di B + 2 sambungan haspel');
  assert.equal(vol(baru, '3005198'), 3, 'labeling JB tapping + 2 haspel');
  assert.equal(vol(baru, '3005195'), core + 3 * 6, 'jointing: 2 di ODF user + 6 core x (JB tapping + 2 JB haspel)');
  const existing = hitungRAB(r, tanpaSpare, {}, { bJBExisting: true });
  assert.equal(vol(existing, '3005235'), 2, 'B JB existing: hanya JB haspel');
  assert.equal(vol(existing, '3005195'), core + 3 * 6, 'jointing tetap sama');
});

test('jointing kabel 24 core: semua 24 core di JB tapping dan tiap JB haspel', () => {
  const r = ringkasan([timur(0), timur(10500)], [timur(10500), timur(11000)], opsiDefault());
  assert.equal(r.jbHaspel, 2, '10.950 m kabel = 3 haspel');
  assert.equal(vol(hitungRAB(r, opsiDefault()), '3005195'), 2 + 3 * 24);
});

test('jointing tanpa B->POP: hanya 2 di ODF user', () => {
  assert.equal(vol(hitungRAB(ringkasan([timur(0), timur(300)], [], opsiDefault()), opsiDefault()), '3005195'), 2);
});

test('penarikan ADSS = jumlah kabel material (termasuk spare)', () => {
  const baris = hitungRAB(ringkasan([timur(0), timur(800)], [], opsiDefault()), opsiDefault());
  assert.equal(vol(baris, '3005194'), 1000, '800 m + 200');
  assert.equal(vol(baris, 'D126'), 1000);
});

test('volume & harga bisa ditimpa manual', () => {
  const opsi = opsiDefault();
  const r = ringkasan([timur(0), timur(300)], [], opsi);
  const baris = hitungRAB(r, opsi, { '3005192': { volume: 2 }, '3005193': { harga: 1000000 } });
  assert.equal(vol(baris, '3005192'), 2);
  assert.equal(baris.find((b) => b.id === '3005193').jumlah, 1000000);
});

test('katalog SBU: 128 item, nomor urut, kode unik', () => {
  assert.equal(KATALOG.length, 128);
  assert.deepEqual(KATALOG.map((k) => k.no), Array.from({ length: 128 }, (_, i) => i + 1));
  assert.equal(new Set(KATALOG.map((k) => k.id)).size, 128);
  assert.equal(KATALOG.filter((k) => k.bagian === 'D').length, 16);
});
