"""Server lokal aplikasi RAB Jalur Kabel: http://localhost:8765

Sama seperti `python -m http.server`, tapi:
- browser selalu mengecek file terbaru (tidak memakai CSS/JS lama dari cache setelah aplikasi diperbarui);
- hanya bisa dibuka dari komputer ini (127.0.0.1), tidak dari jaringan;
- ada proxy /overpass: query data jalan diteruskan ke banyak server Overpass bergantian sampai ada yang
  berhasil. Karena lewat server ini (bukan browser), mirror yang tidak mengizinkan CORS tetap bisa dipakai.

Pemakaian: python server.py [port]
"""
import functools
import http.server
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Server Overpass publik yang punya data Indonesia, urut prioritas (diuji 15 Okt 2026).
# overpass.osm.ch (hanya Swiss) & overpass.nchc.org.tw (domain mati) sengaja tidak dipakai.
OVERPASS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]
BATAS_PER_SERVER = 30  # detik
BATAS_TOTAL = 120  # detik untuk satu permintaan (semua server)
JEDA_GAGAL = 120  # detik server yang baru gagal ditaruh di urutan belakang
UA = {"User-Agent": "rab-jalur-kabel/1.0 (Diskominfo Singkawang)"}

_terakhir_ok = None
_gagal_sampai = {}


def _habis_waktu(err):
    return isinstance(err, TimeoutError) or "timed out" in str(err).lower() or isinstance(getattr(err, "reason", None), TimeoutError)


def _ringkas(err):
    if isinstance(err, urllib.error.HTTPError):
        return f"HTTP {err.code}"
    if _habis_waktu(err):
        return "tidak merespons"
    return str(getattr(err, "reason", err))[:80]


def _ambil(url, metode, query, timeout):
    data = urllib.parse.urlencode({"data": query})
    req = (urllib.request.Request(url, data=data.encode(), headers=UA) if metode == "POST"
           else urllib.request.Request(f"{url}?{data}", headers=UA))
    with urllib.request.urlopen(req, timeout=timeout) as res:
        isi = res.read()
    js = json.loads(isi)
    # Server kelebihan beban kadang menjawab 200 tanpa data + "remark"; anggap gagal.
    if js.get("remark") and not js.get("elements"):
        raise RuntimeError(js["remark"][:80])
    return isi


def tanya_overpass(query):
    """Coba server satu per satu (yang terakhir berhasil dulu, yang baru gagal belakangan).

    Return (isi JSON bytes, url server). RuntimeError berisi ringkasan galat kalau semua gagal.
    """
    global _terakhir_ok
    mulai = time.time()
    urut = sorted(OVERPASS, key=lambda u: (u != _terakhir_ok, _gagal_sampai.get(u, 0) > mulai))
    galat = []
    for url in urut:
        sisa = BATAS_TOTAL - (time.time() - mulai)
        if sisa < 5:
            galat.append("waktu habis")
            break
        timeout = min(BATAS_PER_SERVER, sisa)
        try:
            try:
                isi = _ambil(url, "POST", query, timeout)
            except Exception as err:
                if _habis_waktu(err):
                    raise
                isi = _ambil(url, "GET", query, timeout)  # beberapa mirror hanya menerima GET
            _terakhir_ok = url
            _gagal_sampai.pop(url, None)
            return isi, url
        except Exception as err:
            galat.append(f"{urllib.parse.urlparse(url).hostname}: {_ringkas(err)}")
            _gagal_sampai[url] = time.time() + JEDA_GAGAL
    raise RuntimeError("; ".join(galat))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        bagian = urllib.parse.urlparse(self.path)
        if bagian.path == "/overpass":
            return self._proxy(urllib.parse.parse_qs(bagian.query).get("data", [""])[0])
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/overpass":
            return self.send_error(404)
        isi = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        return self._proxy(urllib.parse.parse_qs(isi).get("data", [""])[0])

    def _kirim(self, kode, isi, server=None):
        self.send_response(kode)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(isi)))
        if server:
            self.send_header("X-Overpass-Server", server)
        self.end_headers()
        self.wfile.write(isi)

    def _proxy(self, query):
        if not query:
            return self._kirim(400, json.dumps({"error": "parameter data kosong"}).encode())
        try:
            isi, url = tanya_overpass(query)
        except RuntimeError as err:
            self.log_message("Overpass gagal semua: %s", err)
            return self._kirim(502, json.dumps({"error": "semua server Overpass gagal", "detail": str(err)}).encode())
        host = urllib.parse.urlparse(url).hostname
        self.log_message("Overpass OK lewat %s (%d KB)", host, len(isi) // 1024)
        return self._kirim(200, isi, host)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(Handler, directory=str(Path(__file__).resolve().parent))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"RAB Jalur Kabel berjalan di http://localhost:{port} (Ctrl+C untuk berhenti)")
        server.serve_forever()
