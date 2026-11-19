#!/usr/bin/env python3
"""tg-rss-bridge – public Telegram channel -> RSS 2.0, no account, stdlib only.

Reads the public web preview https://t.me/s/<channel> and serves the latest
posts as an RSS feed that any reader (Radaric included) can subscribe to.

    python3 scripts/tg-rss-bridge.py                  # 127.0.0.1:8995
    python3 scripts/tg-rss-bridge.py --host 0.0.0.0 --port 8995

    GET /tg/<channel>        RSS 2.0, newest first (about 20 posts)
    GET /health              "ok"

Each item: title (first line of the post), link to the post, guid
https://t.me/<channel>/<id>, pubDate, description with the post text as HTML
(links, line breaks, photo).

Links point to the embed view https://t.me/<channel>/<id>?embed=1: readers that
fetch the article page (Radaric does, with Readability) get the full post text
there, while the plain post page yields only page chrome. --plain-links turns
this off.

Limits: only channels with the public web preview turned on; private channels
and groups are out of reach without an account. Telegram serves the last ~20
posts per page; the bridge caches each channel for --ttl seconds.

Note for Radaric: its feed fetcher refuses loopback and private-network hosts
(lib/url-validation.ts, SSRF guard). Run the bridge where Radaric is allowed to
reach it, or allow the bridge host explicitly in your fork.
"""

from __future__ import annotations

import argparse
import html
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from email.utils import format_datetime
from datetime import datetime, timezone
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHANNEL_RE = re.compile(r"^[A-Za-z0-9_]{3,64}$")
BG_URL_RE = re.compile(r"background-image:url\('([^']+)'\)")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) tg-rss-bridge/1.0"
KEEP_TAGS = {"b", "strong", "i", "em", "u", "s", "code", "pre", "blockquote"}


class PostParser(HTMLParser):
    """Collects posts from the t.me/s/<channel> page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.posts: list[dict] = []
        self.meta: dict[str, str] = {}
        self.div_depth = 0
        self.post: dict | None = None
        self.post_depth = 0
        self.text_depth = 0  # div depth of the post text block, 0 = outside
        self.in_date_link = False

    # -- helpers ---------------------------------------------------------
    @staticmethod
    def _classes(attrs: dict) -> set[str]:
        return set((attrs.get("class") or "").split())

    def _emit(self, html_piece: str, text_piece: str = "") -> None:
        if self.post is not None and self.text_depth:
            self.post["html"].append(html_piece)
            self.post["text"].append(text_piece)

    # -- parser hooks ----------------------------------------------------
    def handle_starttag(self, tag: str, attrs_list) -> None:
        attrs = dict(attrs_list)
        cls = self._classes(attrs)

        if tag == "meta" and attrs.get("property", "").startswith("og:"):
            self.meta[attrs["property"]] = attrs.get("content", "")
            return

        if tag == "div":
            self.div_depth += 1
            if "tgme_widget_message" in cls and attrs.get("data-post"):
                post_id = attrs["data-post"].rsplit("/", 1)[-1]
                self.post = {"id": post_id, "html": [], "text": [],
                             "date": None, "media": []}
                self.post_depth = self.div_depth
                return
            if self.post is not None and "js-message_text" in cls and not self.text_depth:
                self.text_depth = self.div_depth
                return

        if self.post is None:
            return

        style = attrs.get("style") or ""
        if ("tgme_widget_message_photo_wrap" in cls
                or "tgme_widget_message_video_thumb" in cls
                or "link_preview_image" in cls):
            m = BG_URL_RE.search(style)
            if m and m.group(1) not in self.post["media"]:
                self.post["media"].append(m.group(1))

        if tag == "a" and "tgme_widget_message_date" in cls:
            self.in_date_link = True
        if tag == "time" and self.in_date_link and attrs.get("datetime"):
            self.post["date"] = attrs["datetime"]

        if not self.text_depth:
            return
        if tag == "br":
            self._emit("<br/>", "\n")
        elif tag == "a":
            href = attrs.get("href") or ""
            if href.startswith(("http://", "https://")):
                self._emit(f'<a href="{html.escape(href, quote=True)}">')
            else:
                self._emit("<a>")
        elif tag in KEEP_TAGS:
            self._emit(f"<{tag}>")

    def handle_startendtag(self, tag: str, attrs_list) -> None:
        if tag == "div":  # <div/> is not a real container in HTML
            return
        self.handle_starttag(tag, attrs_list)

    def handle_endtag(self, tag: str) -> None:
        if tag == "div":
            if self.text_depth and self.div_depth == self.text_depth:
                self.text_depth = 0
            if self.post is not None and self.div_depth == self.post_depth:
                self.posts.append(self.post)
                self.post = None
                self.text_depth = 0
            self.div_depth -= 1
            return
        if tag == "a":
            if self.in_date_link:
                self.in_date_link = False
            if self.text_depth:
                self._emit("</a>")
            return
        if self.text_depth and tag in KEEP_TAGS:
            self._emit(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self._emit(html.escape(data, quote=False), data)


def fetch_page(channel: str, timeout: float = 15.0) -> str:
    req = urllib.request.Request(
        f"https://t.me/s/{channel}",
        headers={"User-Agent": UA, "Accept-Language": "ru,en;q=0.8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def first_line(text: str, limit: int = 120) -> str:
    for line in text.splitlines():
        line = " ".join(line.split())
        if line:
            return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"
    return ""


def rfc822(iso: str | None) -> str:
    if not iso:
        return format_datetime(datetime.now(timezone.utc))
    try:
        return format_datetime(datetime.fromisoformat(iso.replace("Z", "+00:00")))
    except ValueError:
        return format_datetime(datetime.now(timezone.utc))


def build_rss(channel: str, page: str, plain_links: bool = False) -> str:
    p = PostParser()
    p.feed(page)
    title = p.meta.get("og:title") or channel
    about = p.meta.get("og:description") or f"Telegram channel @{channel}"
    channel_url = f"https://t.me/{channel}"
    x = html.escape
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
        "<channel>",
        f"<title>{x(title)}</title>",
        f"<link>{x(channel_url)}</link>",
        f"<description>{x(about)}</description>",
        f"<lastBuildDate>{format_datetime(datetime.now(timezone.utc))}</lastBuildDate>",
        "<generator>tg-rss-bridge</generator>",
    ]
    for post in reversed(p.posts):  # the page lists oldest first
        text = "".join(post["text"]).strip()
        body = "".join(post["html"]).strip()
        if not text and not post["media"]:
            continue  # service messages, polls, stickers without text
        for url in post["media"][:4]:
            body += f'<p><img src="{x(url, quote=True)}"/></p>'
        permalink = f"{channel_url}/{post['id']}"
        link = permalink if plain_links else f"{permalink}?embed=1"
        item_title = first_line(text) or f"{title} · {post['id']}"
        out += [
            "<item>",
            f"<title>{x(item_title)}</title>",
            f"<link>{x(link)}</link>",
            f'<guid isPermaLink="true">{x(permalink)}</guid>',
            f"<pubDate>{rfc822(post['date'])}</pubDate>",
            f"<description>{x(body)}</description>",
            f"<content:encoded>{x(body)}</content:encoded>",
        ]
        if post["media"]:
            out.append(f'<enclosure url="{x(post["media"][0], quote=True)}" type="image/jpeg" length="0"/>')
        out.append("</item>")
    out += ["</channel>", "</rss>"]
    return "\n".join(out)


class Cache:
    def __init__(self, ttl: float, plain_links: bool = False) -> None:
        self.ttl = ttl
        self.plain_links = plain_links
        self.lock = threading.Lock()
        self.data: dict[str, tuple[float, str]] = {}

    def get(self, channel: str) -> str:
        now = time.time()
        with self.lock:
            hit = self.data.get(channel)
            if hit and now - hit[0] < self.ttl:
                return hit[1]
        rss = build_rss(channel, fetch_page(channel), self.plain_links)
        with self.lock:
            self.data[channel] = (now, rss)
        return rss


def make_handler(cache: Cache):
    class Handler(BaseHTTPRequestHandler):
        server_version = "tg-rss-bridge/1.0"

        def _send(self, code: int, body: str, ctype: str) -> None:
            raw = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", f"max-age={int(cache.ttl)}")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(raw)

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0].rstrip("/")
            if path in ("", "/health"):
                self._send(200, "ok\nusage: /tg/<channel>\n", "text/plain; charset=utf-8")
                return
            parts = path.strip("/").split("/")
            if len(parts) != 2 or parts[0] != "tg" or not CHANNEL_RE.match(parts[1]):
                self._send(404, "not found: use /tg/<channel>\n", "text/plain; charset=utf-8")
                return
            try:
                rss = cache.get(parts[1].lower())
            except urllib.error.HTTPError as e:
                self._send(502, f"t.me answered {e.code}\n", "text/plain; charset=utf-8")
                return
            except Exception as e:  # network, timeout, parse
                self._send(502, f"bridge error: {type(e).__name__}\n", "text/plain; charset=utf-8")
                return
            self._send(200, rss, "application/rss+xml; charset=utf-8")

        def log_message(self, fmt: str, *args) -> None:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="Public Telegram channel -> RSS 2.0")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8995)
    ap.add_argument("--ttl", type=float, default=120.0, help="cache seconds per channel")
    ap.add_argument("--plain-links", action="store_true",
                    help="link items to https://t.me/<channel>/<id> instead of the embed view")
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port),
                                 make_handler(Cache(args.ttl, args.plain_links)))
    print(f"tg-rss-bridge on http://{args.host}:{args.port}/tg/<channel>", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
