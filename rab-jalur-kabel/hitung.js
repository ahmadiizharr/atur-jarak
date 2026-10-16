// Perhitungan jalur kabel & RAB. Tanpa DOM supaya bisa dites di Node.
import { KATALOG } from './katalog.js';

const R_BUMI = 6371008.8; // meter

export const opsiDefault = () => ({
  modeTiang: 'otomatis', // 'otomatis' = tiang tiap jarakTiang di sepanjang jalur, 'klik' = tiap titik yang diklik adalah tiang
  jarakTiang: 50,        // m, tiang di jalan rata-rata tiap 50 m
  deadendTiap: 4,     // tiang ke-4, 8, ... deadend; sisanya suspension. Tiang terakhir (B) selalu deadend.
  spareKabel: true,   // tambah spare kabel otomatis, lihat kabelDenganSpare()
  core: 2,            // core di ODF user: tracing user, jointing user, OTDR (JB tapping/haspel = semua core kabel)
  spareTracing: 5,    // tambahan tracing core sebagai spare
  batasKabel24: 10000, // m, tarikan A→B lebih dari ini pakai kabel ADSS 24 core (selain itu 6 core)
  batasTransportKm: 80, // km garis lurus A ke kota Pontianak; lebih jauh = wajib Trans ADSS >120 km (±110 km jalan)
  kelasJalan: 'besar', // jalan yang boleh dilewati rute otomatis, lihat KELAS_JALAN di rute.js
  radiusJB: 60,        // m, JB sejauh ini dari jalur B→POP dihitung "dilewati" (dan dilewati jalur di mode "Ikuti jalur JB")
  panjangHaspel: 4000, // m kabel per haspel; tiap sambungan antar haspel di A→B wajib 1 JB
  radiusCariB: 5,      // km, radius dari A untuk menampilkan JB kandidat titik B
  pembulatan: 1000,    // Rp, harga total tiap item dibulatkan ke atas ke kelipatan ini (1 = tanpa pembulatan)
});

/** Pusat kota Pontianak, acuan jarak untuk transportasi ADSS. */
export const KOTA_PONTIANAK = { lat: -0.0263, lng: 109.3425 };

/**
 * Panjang kabel dengan spare dari panjang tarikan (m):
 * di bawah 200 m -> 500 m; lebih dari 700 dan di bawah 1000 m -> +200 m; selain itu -> +450 m.
 */
export function kabelDenganSpare(panjangM) {
  if (!(panjangM > 0)) return 0;
  const L = Math.ceil(panjangM - 1e-9);
  if (L < 200) return 500;
  if (L > 700 && L < 1000) return L + 200;
  return L + 450;
}

/** Bulatkan ke atas ke kelipatan `kelipatan` (mis. 1000). Kelipatan <= 1 = tidak dibulatkan. */
export function bulatkanAtas(nilai, kelipatan) {
  const k = Number(kelipatan) || 1;
  if (k <= 1) return nilai;
  // Buang derau floating point (mis. 0.1 * 3) sebelum dibulatkan.
  return Math.ceil(Math.round(nilai * 100) / 100 / k) * k;
}

/** Item terdekat ({nama, lat, lng}) dari daftar ke titik: {...item, jarak} atau null kalau daftar kosong. */
export function terdekat(titik, daftar) {
  let hasil = null;
  for (const item of daftar) {
    const d = jarak(titik, item);
    if (!hasil || d < hasil.jarak) hasil = { ...item, jarak: d };
  }
  return hasil;
}

/** Tandai arah JB terhadap POP: keP = jarak JB→POP, searah = JB lebih dekat ke POP daripada titik A. */
export function tandaiArahPOP(a, jbs, pop) {
  const dariA = jarak(a, pop);
  return jbs.map((j) => {
    const keP = jarak(j, pop);
    return { ...j, keP, searah: keP < dariA };
  });
}

/** JB ([nama, lat, lng]) dalam radius meter dari pusat, urut terdekat: [{idx, nama, lat, lng, jarak}]. */
export function jbDalamRadius(pusat, daftarJB, radius) {
  const hasil = [];
  daftarJB.forEach(([nama, lat, lng], idx) => {
    const d = jarak(pusat, { lat, lng });
    if (d <= radius) hasil.push({ idx, nama, lat, lng, jarak: d });
  });
  return hasil.sort((a, b) => a.jarak - b.jarak);
}

/** JB di luar radius tracing tapi masih sejauh ini dari jalur B→POP ditampilkan sebagai referensi. */
export const RADIUS_REFERENSI_JB = 300;

/** Jarak dua titik {lat, lng} dalam meter (haversine). */
export function jarak(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_BUMI * Math.asin(Math.sqrt(h));
}

/** Panjang polyline dalam meter. */
export function panjang(titik) {
  let total = 0;
  for (let i = 1; i < titik.length; i++) total += jarak(titik[i - 1], titik[i]);
  return total;
}

/** Proyeksi titik ke segmen a-b: {t, titik, d (meter)}. */
export function proyeksi(pt, a, b) {
  const k = Math.cos((pt.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * k;
  const dy = b.lat - a.lat;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((pt.lng - a.lng) * k * dx + (pt.lat - a.lat) * dy) / L2)) : 0;
  const titik = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { t, titik, d: jarak(pt, titik) };
}

/**
 * JB ([nama, lat, lng]) yang berjarak <= radius meter dari jalur,
 * urut dari awal jalur: [{nama, lat, lng, jarak, posisi}] (posisi = meter dari awal jalur).
 */
export function jbDekatJalur(jalur, daftarJB, radius) {
  if (jalur.length < 2 || !daftarJB.length) return [];
  const lats = jalur.map((t) => t.lat);
  const lngs = jalur.map((t) => t.lng);
  const padLat = radius / 110000;
  const padLng = padLat / Math.max(Math.cos((lats[0] * Math.PI) / 180), 0.1);
  const [s, n, w, e] = [Math.min(...lats) - padLat, Math.max(...lats) + padLat, Math.min(...lngs) - padLng, Math.max(...lngs) + padLng];
  const awalSeg = [0];
  for (let i = 1; i < jalur.length; i++) awalSeg.push(awalSeg[i - 1] + jarak(jalur[i - 1], jalur[i]));
  const hasil = [];
  for (const [nama, lat, lng] of daftarJB) {
    if (lat < s || lat > n || lng < w || lng > e) continue;
    const pt = { lat, lng };
    let terbaik = null;
    for (let i = 1; i < jalur.length; i++) {
      const pr = proyeksi(pt, jalur[i - 1], jalur[i]);
      if (!terbaik || pr.d < terbaik.d) terbaik = { d: pr.d, posisi: awalSeg[i - 1] + jarak(jalur[i - 1], pr.titik) };
    }
    if (terbaik.d <= radius) hasil.push({ nama, lat, lng, jarak: terbaik.d, posisi: terbaik.posisi });
  }
  return hasil.sort((a, b) => a.posisi - b.posisi);
}

/**
 * Jalur yang dibelokkan supaya lewat tepat di titik JB (hasil jbDekatJalur), urut sesuai posisinya
 * di sepanjang jalur. Titik awal & akhir jalur tidak berubah.
 */
export function lewatJB(jalur, jbs) {
  if (jalur.length < 2 || !jbs.length) return jalur;
  const urut = [...jbs].sort((a, b) => a.posisi - b.posisi);
  const hasil = [jalur[0]];
  let posisi = 0;
  let k = 0;
  for (let i = 1; i < jalur.length; i++) {
    posisi += jarak(jalur[i - 1], jalur[i]);
    const akhir = i === jalur.length - 1;
    while (k < urut.length && (urut[k].posisi <= posisi || akhir)) {
      hasil.push({ lat: urut[k].lat, lng: urut[k].lng });
      k++;
    }
    hasil.push(jalur[i]);
  }
  return hasil;
}

/** Titik di sepanjang polyline pada jarak `d` meter dari awal. */
export function titikPada(titik, d) {
  for (let i = 1; i < titik.length; i++) {
    const a = titik[i - 1];
    const b = titik[i];
    const seg = jarak(a, b);
    if (d <= seg || i === titik.length - 1) {
      const f = seg > 0 ? Math.min(Math.max(d / seg, 0), 1) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
    d -= seg;
  }
  return titik[titik.length - 1];
}

/** 'S' (suspension) atau 'D' (deadend) untuk tiang ke-i (mulai 1) dari n tiang. */
export function jenisTiang(i, n, deadendTiap) {
  return i === n || (deadendTiap > 0 && i % deadendTiap === 0) ? 'D' : 'S';
}

/** Posisi tiang di jalur A→B. Mode 'klik': semua titik setelah A (termasuk B). */
export function posisiTiang(jalur, opsi) {
  if (jalur.length < 2) return [];
  if (opsi.modeTiang === 'klik') return jalur.slice(1);
  const L = panjang(jalur);
  const span = Math.max(Number(opsi.jarakTiang) || 0, 1);
  const n = L > 0 ? Math.ceil(L / span - 1e-9) : 0;
  return Array.from({ length: n }, (_, k) => titikPada(jalur, Math.min((k + 1) * span, L)));
}

/**
 * Ringkasan jalur: panjang, kabel, daftar tiang + jumlah suspension/deadend,
 * JB yang dilewati B→POP (tracing) dan JB sambungan haspel di A→B. JB di jalur A→B tidak dihitung tracing.
 */
export function ringkasan(jalurAB, jalurBPOP, opsi, ubahTiang = {}, daftarJB = []) {
  const panjangAB = panjang(jalurAB);
  const panjangBPOP = panjang(jalurBPOP);
  const posisi = posisiTiang(jalurAB, opsi);
  const n = posisi.length;
  const tiang = posisi.map((p, k) => {
    const no = k + 1;
    const u = ubahTiang[no] || {};
    return { no, lat: p.lat, lng: p.lng, jenis: u.jenis || jenisTiang(no, n, opsi.deadendTiap), baru: !!u.baru, diubah: !!u.jenis };
  });
  const kabel = opsi.spareKabel === false ? Math.ceil(panjangAB - 1e-9) : kabelDenganSpare(panjangAB);
  const haspel = Math.max(Number(opsi.panjangHaspel) || 0, 1);
  const radiusJB = Number(opsi.radiusJB) || 0;
  const jbSekitar = jbDekatJalur(jalurBPOP, daftarJB, Math.max(RADIUS_REFERENSI_JB, radiusJB));
  return {
    panjangAB,
    panjangBPOP,
    kabel,
    jbTracing: jbSekitar.filter((j) => j.jarak <= radiusJB),
    jbReferensi: jbSekitar.filter((j) => j.jarak > radiusJB),
    jbHaspel: kabel > 0 ? Math.ceil(kabel / haspel - 1e-9) - 1 : 0,
    jarakPontianak: jalurAB.length ? jarak(jalurAB[0], KOTA_PONTIANAK) : 0,
    tiang,
    suspension: tiang.filter((t) => t.jenis === 'S').length,
    deadend: tiang.filter((t) => t.jenis === 'D').length,
    tiangBaru: tiang.filter((t) => t.baru).length,
  };
}

/** Kabel 24 core dipakai kalau tarikan A→B lebih dari batasKabel24 meter; selain itu 6 core. */
export const pakaiKabel24 = (r, opsi) => r.panjangAB > (Number(opsi.batasKabel24) || Infinity);

/** Jumlah core kabel tarikan A→B: 24 kalau tarikan lebih dari batasKabel24, selain itu 6. */
export const coreKabel = (r, opsi) => (pakaiKabel24(r, opsi) ? 24 : 6);

/**
 * Jointing per core: `core` di ODF user + semua core kabel di JB tapping (B)
 * + semua core kabel di tiap JB sambungan haspel (tarikan 4 km atau lebih).
 */
export const jumlahJointing = (r, opsi) => {
  if (!(r.kabel > 0)) return 0;
  const jbDisambung = (r.panjangBPOP > 0 ? 1 : 0) + r.jbHaspel;
  return (Number(opsi.core) || 0) + jbDisambung * coreKabel(r, opsi);
};

/** Transportasi ADSS (>120 km) wajib kalau titik A jauh dari kota Pontianak (mis. Singkawang, Sambas). */
export const perluTransport = (r, opsi) => r.kabel > 0 && r.jarakPontianak > (Number(opsi.batasTransportKm) || 0) * 1000;

/** Tracing core: tiap JB yang dilewati B→POP + `core` di user + spare. */
export const jumlahTracing = (r, opsi) => (r.kabel > 0 ? r.jbTracing.length + (Number(opsi.core) || 0) + (Number(opsi.spareTracing) || 0) : 0);

/**
 * Volume otomatis per id katalog (standar tarikan FOC outdoor) berdasarkan ringkasan jalur.
 * `konteks.bJBExisting`: titik B adalah JB existing (tapping), jadi tidak perlu Joint Box baru di B.
 * Item lain di katalog (AP, CCTV, long span, galian, dll.) 0 dan bisa diisi manual di tabel RAB.
 */
export function volumeOtomatis(r, opsi, konteks = {}) {
  const satu = r.kabel > 0 ? 1 : 0;
  const adaTracing = r.panjangBPOP > 0;
  const core = Number(opsi.core) || 0;
  const k24 = pakaiKabel24(r, opsi);
  const tracing = jumlahTracing(r, opsi);
  const deadend = Math.ceil(tracing / 3);
  // JB yang dikerjakan: JB tapping di B (kalau ada tracing) + tiap sambungan haspel di A→B.
  const jbDikerjakan = (adaTracing ? 1 : 0) + r.jbHaspel;
  // Material JB baru: JB tapping hanya kalau B bukan JB existing.
  const jbBaru = (adaTracing && !konteks.bJBExisting ? 1 : 0) + r.jbHaspel;
  return {
    // A. Jasa
    '3005193': satu, // Survey jalur kabel
    '3005194': r.kabel, // Penarikan FOC ADSS Short Span (m) = jumlah kabel (termasuk spare)
    '3005195': jumlahJointing(r, opsi), // Jointing: 2 di ODF user + semua core di JB tapping & tiap JB haspel
    '3005196': tracing, // Tracing core
    '3005197': satu * core, // OTDR per core
    '3005198': jbDikerjakan, // Labeling Joint Box
    '3005199': tracing, // Labeling Kabel 1 pole 2 label = tracing
    '3005214': satu, // Instalasi FOT MC (POP-CPE)
    '3005218': satu * 2, // Labeling In Site Plan + patch cord, POP & user
    '3005220': satu, // Dokumentasi Teknis Ringan
    // B. Material
    '3005222': deadend, // Fitting Deadend = tracing / 3 (bulat ke atas)
    '3005224': tracing - deadend, // Fitting Suspension = labeling kabel - deadend
    '3005233': k24 ? 0 : satu, // ODF Rack Mounted 6 Core
    '3005231': k24 ? satu : 0, // ODF Rack Mounted 24 Core
    '3005272': satu * 2, // Patch Cord SM single core 5m (POP & user)
    '3005235': jbBaru, // Joint Box 24 Core
    '3005288': r.tiangBaru, // Tiang Besi 7 m
    // C. Transportasi
    '3005293': perluTransport(r, opsi) ? 1 : 0, // Trans ADSS SS/LS >120 km
    // D. Material
    D120: satu, // SFP-BIDI 1550nm ZTT
    D121: satu, // SFP-BIDI 1310nm ZTT
    D124: satu, // Switch ISCOM2600-12G Raisecom
    D126: k24 ? 0 : r.kabel, // FOC ADSS SS 6F/1T ZTT (m)
    D127: k24 ? r.kabel : 0, // FOC ADSS SS 24F/4T YOFI (m)
  };
}

/**
 * Baris RAB lengkap. `ubah[id] = {volume?, harga?}` menimpa nilai otomatis.
 * Harga total tiap item dibulatkan ke atas sesuai opsi.pembulatan; harga satuan tetap sesuai katalog.
 */
export function hitungRAB(r, opsi, ubah = {}, konteks = {}) {
  const auto = volumeOtomatis(r, opsi, konteks);
  return KATALOG.map((k) => {
    const u = ubah[k.id] || {};
    const volumeAuto = auto[k.id] ?? 0;
    const volume = u.volume ?? volumeAuto;
    const harga = u.harga ?? k.harga;
    const jumlah = bulatkanAtas(volume * harga, opsi.pembulatan);
    return { ...k, volumeAuto, volume, harga, jumlah, diubah: u.volume != null || u.harga != null };
  });
}

export const totalRAB = (baris) => baris.reduce((s, b) => s + b.jumlah, 0);

/** Subtotal format RAB SBU: "RAB JASA Only" (A+B+C), "RAB Material" (D), total. */
export function subtotalRAB(baris) {
  const jasa = totalRAB(baris.filter((b) => b.bagian !== 'D'));
  const material = totalRAB(baris.filter((b) => b.bagian === 'D'));
  return { jasa, material, total: jasa + material };
}
