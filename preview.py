"""
preview.py — look at the site on your own computer.

Run:   python preview.py
Open:  http://localhost:8000

It is the same idea as "python -m http.server", with one difference: it tells the
browser never to keep old copies of the files. So after you edit a file, a normal
refresh always shows the new version.
"""
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")     # "do not save a copy of this file"
        super().end_headers()


if __name__ == "__main__":
    print("Serving the site at http://localhost:8000  (press Ctrl+C to stop)")
    http.server.test(HandlerClass=NoCacheHandler, port=8000, bind="127.0.0.1")
