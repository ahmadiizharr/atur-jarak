"""Buat data jalan besar Kalimantan Barat dari OpenStreetMap -> jalan-kalbar.json.

Aplikasi memakai file ini untuk menghitung rute di browser tanpa memanggil server Overpass
tiap kali (lihat grafOffline di rute.js). Jalankan ulang kapan saja untuk memperbarui data.
Data: (c) OpenStreetMap contributors, lisensi ODbL.

Pemakaian (dari folder rab-jalur-kabel):
    python tools/unduh_jalan_kalbar.py --hitung              # cek jumlah jalan & titik di Overpass (tanpa unduh)
    python tools/unduh_jalan_kalbar.py                       # ambil dari server Overpass
    python tools/unduh_jalan_kalbar.py --pbf kalimantan-latest.osm.pbf
        # baca ekstrak Geofabrik (https://download.geofabrik.de/asia/indonesia/kalimantan-latest.osm.pbf),
        # tidak tergantung server Overpass; perlu: pip install osmium

Titik di tengah ruas yang hampir lurus dibuang (toleransi TOLERANSI_M) supaya file kecil;
persimpangan & ujung jalan selalu disimpan, jadi rute tetap tersambung sama persis.
"""
import datetime
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SERVER = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Urutan harus sama dengan KELAS_OFFLINE di rute.js (residential sengaja tidak ikut: terlalu banyak & sering gang).
KELAS = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified"]
AREA = 'area["ISO3166-2"="ID-KB"]->.kb;'  # Provinsi Kalimantan Barat
JALAN = f'way(area.kb)["highway"~"^({"|".join(KELAS)})(_link)?$"]'
# Kotak Kalbar, dipakai untuk menyaring ekstrak Geofabrik (yang berisi seluruh Kalimantan).
KOTAK_KALBAR = {"s": -3.2, "w": 108.5, "n": 2.15, "e": 114.3}
TOLERANSI_M = 5
KELUARAN = Path(__file__).resolve().parent.parent / "jalan-kalbar.json"


def overpass(query, timeout=900):
    body = urllib.parse.urlencode({"data": query}).encode()
    galat = None
    for url in SERVER:
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "rab-jalur-kabel/1.0 (Diskominfo Singkawang)"})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.load(res)
        except Exception as err:  # server sibuk / menolak -> coba server berikutnya
            print(f"  {url} gagal: {err}", file=sys.stderr)
            galat = err
            time.sleep(5)
    sys.exit(f"Semua server Overpass gagal, coba lagi nanti atau pakai --pbf. Galat terakhir: {galat}")


def hitung():
    data = overpass(f"[out:json][timeout:180];{AREA}({JALAN};>;);out count;", timeout=300)
    tags = data["elements"][0]["tags"]
    print(f"Kalbar: {tags['ways']} ruas jalan, {tags['nodes']} titik (sebelum disederhanakan)")


def ambil_overpass():
    """-> [(indeks kelas, [(id, lat, lon), ...]), ...]"""
    print("Mengambil data jalan Kalbar dari Overpass (bisa 1-3 menit)...")
    data = overpass(f"[out:json][timeout:600];{AREA}{JALAN}->.w;.w out body qt;.w >;out skel qt;")
    titik = {e["id"]: (e["lat"], e["lon"]) for e in data["elements"] if e["type"] == "node"}
    ways = []
    for el in data["elements"]:
        kelas = el.get("tags", {}).get("highway", "").removesuffix("_link") if el["type"] == "way" else ""
        if kelas in KELAS:
            ways.append((KELAS.index(kelas), [(n, *titik[n]) for n in el["nodes"] if n in titik]))
    return ways


def ambil_pbf(path):
    """Baca ekstrak .osm.pbf (Geofabrik) dan ambil jalan yang menyentuh kotak Kalbar."""
    import osmium  # pip install osmium

    k = KOTAK_KALBAR
    ways = []

    class Jalan(osmium.SimpleHandler):
        def way(self, w):
            kelas = w.tags.get("highway", "").removesuffix("_link")
            if kelas not in KELAS:
                return
            pts = [(n.ref, n.lat, n.lon) for n in w.nodes if n.location.valid()]
            if any(k["s"] <= la <= k["n"] and k["w"] <= lo <= k["e"] for _, la, lo in pts):
                ways.append((KELAS.index(kelas), pts))

    print(f"Membaca {path} (beberapa menit)...")
    Jalan().apply_file(str(path), locations=True)
    return ways


def jarak_ke_garis(p, a, b):
    """Jarak (meter) titik p ke garis a-b, proyeksi datar lokal."""
    k = math.cos(math.radians(p[0]))
    ax, ay, bx, by, px, py = a[1] * k, a[0], b[1] * k, b[0], p[1] * k, p[0]
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111195


def douglas_peucker(pts, tol):
    """Indeks titik yang disimpan (selalu awal & akhir)."""
    simpan = {0, len(pts) - 1}
    tumpuk = [(0, len(pts) - 1)]
    while tumpuk:
        i, j = tumpuk.pop()
        jauh, idx = 0, None
        for m in range(i + 1, j):
            d = jarak_ke_garis(pts[m], pts[i], pts[j])
            if d > jauh:
                jauh, idx = d, m
        if idx is not None and jauh > tol:
            simpan.add(idx)
            tumpuk += [(i, idx), (idx, j)]
    return sorted(simpan)


def sederhanakan(ways):
    """Buang titik di tengah ruas yang hampir lurus; persimpangan (titik dipakai >1 kali) & ujung tetap."""
    pakai = {}
    for _, pts in ways:
        for nid, *_ in pts:
            pakai[nid] = pakai.get(nid, 0) + 1
    hasil = []
    for kelas, pts in ways:
        if len(pts) < 2:
            continue
        tetap = [0] + [i for i in range(1, len(pts) - 1) if pakai[pts[i][0]] > 1] + [len(pts) - 1]
        dipakai = []
        for a, b in zip(tetap, tetap[1:]):
            bagian = pts[a:b + 1]
            idx = douglas_peucker([(la, lo) for _, la, lo in bagian], TOLERANSI_M)
            dipakai += [bagian[i] for i in idx[(1 if dipakai else 0):]]
        hasil.append((kelas, dipakai))
    return hasil


def tulis(ways, sumber):
    indeks, nodes, keluar = {}, [], []
    for kelas, pts in sederhanakan(ways):
        ids = []
        for nid, lat, lon in pts:
            if nid not in indeks:
                indeks[nid] = len(indeks)
                nodes += [round(lat * 1e5), round(lon * 1e5)]
            ids.append(indeks[nid])
        if len(ids) >= 2:
            keluar.append([kelas, *ids])
    if not keluar:
        sys.exit("Tidak ada data jalan yang diterima, file tidak ditulis.")
    lats, lngs = nodes[0::2], nodes[1::2]
    hasil = {
        "versi": 1,
        "sumber": f"(c) OpenStreetMap contributors (ODbL), {sumber}",
        "dibuat": datetime.date.today().isoformat(),
        "wilayah": "Kalimantan Barat",
        "bbox": {"s": min(lats) / 1e5, "w": min(lngs) / 1e5, "n": max(lats) / 1e5, "e": max(lngs) / 1e5},
        "kelas": KELAS,
        "nodes": nodes,
        "ways": keluar,
    }
    KELUARAN.write_text(json.dumps(hasil, separators=(",", ":")), encoding="utf-8")
    asli = sum(len(p) for _, p in ways)
    print(f"{len(keluar)} ruas jalan, {len(indeks)} titik (dari {asli}) -> {KELUARAN} ({KELUARAN.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    if "--hitung" in sys.argv:
        hitung()
    elif "--pbf" in sys.argv:
        pbf = Path(sys.argv[sys.argv.index("--pbf") + 1])
        tulis(ambil_pbf(pbf), f"Geofabrik {pbf.name}")
    else:
        tulis(ambil_overpass(), "via Overpass API")
