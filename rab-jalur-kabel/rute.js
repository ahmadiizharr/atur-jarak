// Rute kabel terpendek di atas graf jalan OSM (data Overpass) yang hanya berisi kelas jalan terpilih.
// Gang, jalan setapak, jalan servis, dll. tidak pernah masuk graf, jadi tidak mungkin dilewati.
import { jarak, proyeksi } from './hitung.js';

export const KELAS_JALAN = {
  besar: '^(motorway|trunk|primary|secondary|tertiary)(_link)?$',
  sedang: '^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$',
  lingkungan: '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$',
};

export function queryOverpass(bbox, kelas) {
  const { s, w, n, e } = bbox;
  return `[out:json][timeout:30];way["highway"~"${KELAS_JALAN[kelas]}"](${s},${w},${n},${e});(._;>;);out skel qt;`;
}

/** Kotak area yang memuat semua titik + margin (derajat). */
export function bboxUntuk(titik, padMin = 0.01) {
  const lats = titik.map((t) => t.lat);
  const lngs = titik.map((t) => t.lng);
  const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
  const pad = Math.max(padMin, span * 0.3);
  return { s: Math.min(...lats) - pad, w: Math.min(...lngs) - pad, n: Math.max(...lats) + pad, e: Math.max(...lngs) + pad };
}

export const bboxBerisi = (luar, dalam) => luar.s <= dalam.s && luar.w <= dalam.w && luar.n >= dalam.n && luar.e >= dalam.e;

/** Graf tak berarah dari hasil Overpass. Hanya komponen terhubung terbesar yang dipakai untuk snap. */
export function bangunGraf(osm) {
  const nodes = new Map();
  for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lng: el.lon });
  const adj = new Map();
  const edges = [];
  const tambah = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, w]);
  };
  for (const el of osm.elements) {
    if (el.type !== 'way') continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1];
      const b = el.nodes[i];
      if (a === b || !nodes.has(a) || !nodes.has(b)) continue;
      const w = jarak(nodes.get(a), nodes.get(b));
      tambah(a, b, w);
      tambah(b, a, w);
      edges.push([a, b]);
    }
  }

  // Potongan jalan yang terputus (mis. terpotong batas area) jangan dipakai sebagai titik masuk.
  const komponen = new Map();
  const ukuran = [];
  for (const mulai of adj.keys()) {
    if (komponen.has(mulai)) continue;
    const id = ukuran.length;
    const tumpuk = [mulai];
    komponen.set(mulai, id);
    let n = 0;
    while (tumpuk.length) {
      const u = tumpuk.pop();
      n++;
      for (const [v] of adj.get(u)) {
        if (!komponen.has(v)) {
          komponen.set(v, id);
          tumpuk.push(v);
        }
      }
    }
    ukuran.push(n);
  }
  const utama = ukuran.indexOf(Math.max(...ukuran));
  return { nodes, adj, edges: edges.filter(([a]) => komponen.get(a) === utama) };
}

/** Urutan kelas jalan di file data jalan offline (indeks dipakai di tiap way). */
export const KELAS_OFFLINE = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential'];
/** Jumlah kelas pertama di KELAS_OFFLINE yang boleh dipakai tiap pilihan "Jalan yang dipakai". */
const JUMLAH_KELAS = { besar: 5, sedang: 6, lingkungan: 7 };

/**
 * Graf jalan dari file offline `{bbox, kelas, nodes: [lat*1e5, lng*1e5, ...], ways: [[kelas, i0, i1, ...]]}`
 * untuk area `bbox` dan kelas terpilih. Null kalau file tidak mencakup area `wajib` (titik-titik rute,
 * default = bbox) atau kelas jalan itu. Bbox boleh melebar ke luar file (di sana memang tidak ada jalan).
 */
export function grafOffline(data, bbox, kelas, wajib = bbox) {
  if (!data || !bboxBerisi(data.bbox, wajib) || JUMLAH_KELAS[kelas] > data.kelas.length) return null;
  const batas = JUMLAH_KELAS[kelas];
  const lat = (i) => data.nodes[2 * i] / 1e5;
  const lng = (i) => data.nodes[2 * i + 1] / 1e5;
  const dalam = (i) => lat(i) >= bbox.s && lat(i) <= bbox.n && lng(i) >= bbox.w && lng(i) <= bbox.e;
  const elements = [];
  const dipakai = new Set();
  data.ways.forEach((w, k) => {
    if (w[0] >= batas) return;
    const ids = w.slice(1);
    if (!ids.some(dalam)) return;
    elements.push({ type: 'way', id: k, nodes: ids });
    ids.forEach((i) => dipakai.add(i));
  });
  for (const i of dipakai) elements.push({ type: 'node', id: i, lat: lat(i), lon: lng(i) });
  return bangunGraf({ elements });
}

function snap(graf, pt) {
  let terbaik = null;
  for (const [a, b] of graf.edges) {
    const pr = proyeksi(pt, graf.nodes.get(a), graf.nodes.get(b));
    if (!terbaik || pr.d < terbaik.d) terbaik = { ...pr, a, b };
  }
  return terbaik;
}

function dijkstra(tetangga, mulai, tujuan) {
  const dist = new Map([[mulai, 0]]);
  const prev = new Map();
  const heap = [[0, mulai]];
  const naik = (i) => {
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (heap[j][0] <= heap[i][0]) break;
      [heap[i], heap[j]] = [heap[j], heap[i]];
      i = j;
    }
  };
  const turun = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  };
  while (heap.length) {
    const [d, u] = heap[0];
    const akhir = heap.pop();
    if (heap.length) {
      heap[0] = akhir;
      turun(0);
    }
    if (u === tujuan) break;
    if (d > dist.get(u)) continue;
    for (const [v, w] of tetangga(u)) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push([nd, v]);
        naik(heap.length - 1);
      }
    }
  }
  if (!dist.has(tujuan)) return null;
  const jalur = [tujuan];
  while (jalur[jalur.length - 1] !== mulai) jalur.push(prev.get(jalur[jalur.length - 1]));
  return jalur.reverse();
}

/** Rute P→Q: garis lurus P ke jalan terdekat, lewat jalan terpendek, lalu garis lurus ke Q. */
function ruteLeg(graf, P, Q) {
  const sp = snap(graf, P);
  const sq = snap(graf, Q);
  const ekstra = new Map();
  const tambah = (a, b, w) => {
    if (!ekstra.has(a)) ekstra.set(a, []);
    ekstra.get(a).push([b, w]);
  };
  const hubungkan = (id, s) => {
    for (const ujung of [s.a, s.b]) {
      const w = jarak(s.titik, graf.nodes.get(ujung));
      tambah(id, ujung, w);
      tambah(ujung, id, w);
    }
  };
  hubungkan('S', sp);
  hubungkan('T', sq);
  if ((sp.a === sq.a && sp.b === sq.b) || (sp.a === sq.b && sp.b === sq.a)) {
    const w = jarak(sp.titik, sq.titik);
    tambah('S', 'T', w);
    tambah('T', 'S', w);
  }
  const tetangga = (u) => [...(graf.adj.get(u) || []), ...(ekstra.get(u) || [])];
  const ids = dijkstra(tetangga, 'S', 'T');
  if (!ids) throw new Error('tidak ada jalan yang tersambung');
  return [P, ...ids.map((id) => (id === 'S' ? sp.titik : id === 'T' ? sq.titik : graf.nodes.get(id))), Q];
}

/** Rute melewati semua titik berurutan. legAwal[i] = indeks awal leg titik[i]→titik[i+1] di `titik`. */
/** Titik user (titik belok) yang lebih jauh dari ini dari jalan terpilih dianggap sengaja ditaruh di jalan kecil. */
export const BATAS_LOMPAT_M = 30;

/**
 * Titik pilihan user diprioritaskan.
 * - `wajib`: indeks titik belok yang ditambah user di `titikList`.
 * - `titikUser`: indeks titik lain yang juga dipilih user (mis. A / B), dihitung bersama `wajib`.
 * Untuk leg yang menyentuh titik belok: kalau rute di `graf` harus melompat lurus > BATAS_LOMPAT_M untuk
 * mencapai titik user (titik ada di jalan kecil), leg dihitung ulang di `grafBebas` (jalan lebih lengkap).
 * Kalau kedua ujung leg titik user dan tetap tidak ada jalan yang cocok (mis. jalan servis / belum ada di peta),
 * leg dibuat lurus antar titik, mengikuti garis yang ditarik user, bukan menusuk ke jalan lain.
 */
export function ruteMelalui(graf, titikList, { grafBebas = null, wajib = new Set(), titikUser = new Set() } = {}) {
  if (!graf.edges.length) throw new Error('tidak ada jalan di area ini');
  const titik = [];
  const legAwal = [];
  const dariUser = (k) => wajib.has(k) || titikUser.has(k);
  for (let i = 1; i < titikList.length; i++) {
    const [P, Q] = [titikList[i - 1], titikList[i]];
    let leg = ruteLeg(graf, P, Q);
    const ujung = wajib.has(i - 1) || wajib.has(i) ? [dariUser(i - 1) && 'awal', dariUser(i) && 'akhir'].filter(Boolean) : [];
    const lompat = (l) => Math.max(...ujung.map((u) => (u === 'awal' ? jarak(l[0], l[1]) : jarak(l[l.length - 2], l[l.length - 1]))));
    if (grafBebas?.edges.length && ujung.length && lompat(leg) > BATAS_LOMPAT_M) {
      let bebas = null;
      try {
        bebas = ruteLeg(grafBebas, P, Q);
      } catch {
        // Jalan kecil di sekitar titik tidak tersambung: tetap pakai rute jalan terpilih.
      }
      if (bebas && lompat(bebas) < lompat(leg)) leg = bebas;
    }
    if (ujung.length === 2 && lompat(leg) > BATAS_LOMPAT_M) leg = [P, Q];
    legAwal.push(Math.max(titik.length - 1, 0));
    titik.push(...(titik.length ? leg.slice(1) : leg));
  }
  return { titik, legAwal };
}
