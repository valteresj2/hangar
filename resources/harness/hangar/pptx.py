"""PowerPoint writer with no dependencies: a .pptx is a zip of XML, so we write the XML.
Text stays native and editable; charts/illustrations go in as pictures. Layouts are designed on a 1920x1080 canvas.

Spec (JSON):
{"title": "deck name (footer)", "theme": {"bg": "0B1020", "fg": "F4F6FB", "muted": "98A2B3", "accent": "7C5CFF", "accent2": "22D3EE",
                                          "font": "Segoe UI", "heading_font": "Segoe UI Semibold"},
 "slides": [
   {"layout": "title",   "kicker": "...", "title": "...", "subtitle": "...", "image": "hero.png"},
   {"layout": "section", "kicker": "01", "title": "...", "subtitle": "..."},
   {"layout": "bullets", "title": "...", "bullets": ["...", "..."], "image": "chart.png", "takeaway": "..."},
   {"layout": "kpis",    "title": "...", "kpis": [{"value": "R$ 1,2 mi", "label": "Receita", "delta": "+12%"}], "takeaway": "..."},
   {"layout": "image",   "title": "...", "image": "chart.png", "caption": "...", "full": false},
   {"layout": "two_col", "title": "...", "left": {"heading": "...", "bullets": []}, "right": {"heading": "...", "bullets": []}},
   {"layout": "quote",   "text": "...", "by": "..."},
   {"layout": "closing", "title": "...", "subtitle": "..."}]}"""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

W, H = 1920, 1080
EMU = 6350                       # 1 px of the 1920x1080 canvas (slide is 12192000 x 6858000 EMU)
M = 112                          # outer margin
NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DEFAULT_THEME = {"bg": "0B1020", "fg": "F4F6FB", "muted": "98A2B3", "accent": "7C5CFF", "accent2": "22D3EE",
                 "good": "34D399", "bad": "F87171", "font": "Segoe UI", "heading_font": "Segoe UI Semibold"}


def _hex(c: str) -> str:
    c = str(c).strip().lstrip("#").upper()
    return c if len(c) == 6 and all(ch in "0123456789ABCDEF" for ch in c) else "000000"


def _mix(a: str, b: str, t: float) -> str:
    pa, pb = [int(a[i:i + 2], 16) for i in (0, 2, 4)], [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(pa, pb))


def image_size(path: Path) -> tuple[int, int]:
    with open(path, "rb") as f:
        head = f.read(32)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
        if head[:2] == b"\xff\xd8":                           # JPEG: walk the segments to the frame header
            f.seek(2)
            while True:
                marker = f.read(4)
                if len(marker) < 4:
                    break
                if marker[0] != 0xFF:
                    break
                size = struct.unpack(">H", marker[2:4])[0]
                if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", f.read(5)[1:5])
                    return w, h
                f.seek(size - 2, 1)
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", head[6:10])
    raise ValueError(f"unsupported image format (use PNG or JPEG): {path}")


class _Slide:
    def __init__(self, deck: "Deck"):
        self.deck, self.shapes, self.rels, self.n = deck, [], [], 1

    def _id(self) -> int:
        self.n += 1
        return self.n

    @staticmethod
    def _xfrm(x, y, w, h) -> str:
        return f'<a:xfrm><a:off x="{int(x * EMU)}" y="{int(y * EMU)}"/><a:ext cx="{max(1, int(w * EMU))}" cy="{max(1, int(h * EMU))}"/></a:xfrm>'

    def rect(self, x, y, w, h, color, alpha: float = 1.0, radius: float = 0) -> None:
        i = self._id()
        geom = (f'<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {int(min(50000, radius / max(1, min(w, h)) * 100000))}"/></a:avLst></a:prstGeom>'
                if radius else '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>')
        fill = f'<a:srgbClr val="{_hex(color)}">' + (f'<a:alpha val="{int(alpha * 100000)}"/>' if alpha < 1 else "") + "</a:srgbClr>"
        self.shapes.append(f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="Shape {i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{self._xfrm(x, y, w, h)}{geom}'
                           f'<a:solidFill>{fill}</a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>')

    def text(self, x, y, w, h, paragraphs, size: float = 30, color: str | None = None, bold: bool = False, heading: bool = False,
             align: str = "l", anchor: str = "t", spacing: float = 1.0, after: float = 0, max_lines: int = 0) -> None:
        """paragraphs: str | list[str | dict(text, size, color, bold, heading)]. Sizes are canvas px."""
        th = self.deck.theme
        items = [paragraphs] if isinstance(paragraphs, (str, dict)) else list(paragraphs)
        items = [{"text": p} if isinstance(p, str) else p for p in items if p not in (None, "")]
        if not items:
            return
        if max_lines:                                          # no renderer here: shrink long text by estimate
            longest = max(len(str(p["text"])) for p in items)
            while size > 14 and longest / max(1.0, w / (size * 0.5)) > max_lines:
                size *= 0.93
        i, paras = self._id(), []
        for p in items:
            sz, col = p.get("size", size), _hex(p.get("color") or color or th["fg"])
            face = th["heading_font"] if p.get("heading", heading) else th["font"]
            rpr = (f'<a:rPr lang="pt-BR" sz="{int(sz * 50)}" b="{1 if p.get("bold", bold) else 0}" dirty="0"><a:solidFill><a:srgbClr val="{col}"/></a:solidFill>'
                   f'<a:latin typeface="{escape(face)}"/><a:cs typeface="{escape(face)}"/></a:rPr>')
            paras.append(f'<a:p><a:pPr algn="{align}"><a:lnSpc><a:spcPct val="{int(spacing * 100000)}"/></a:lnSpc><a:spcAft><a:spcPts val="{int(after * 50)}"/></a:spcAft>'
                         f'<a:buNone/></a:pPr><a:r>{rpr}<a:t>{escape(str(p["text"]))}</a:t></a:r></a:p>')
        self.shapes.append(f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="Text {i}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>{self._xfrm(x, y, w, h)}'
                           f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" '
                           f'anchor="{anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>{"".join(paras)}</p:txBody></p:sp>')

    def image(self, path, x, y, w, h, fit: str = "contain", radius: float = 0) -> None:
        p = self.deck.resolve(path)
        iw, ih = image_size(p)
        crop = ""
        if fit == "cover":                                     # crop the source to the box ratio
            box, img = w / h, iw / ih
            if img > box:
                cut = int((1 - box / img) / 2 * 100000)
                crop = f'<a:srcRect l="{cut}" r="{cut}"/>'
            else:
                cut = int((1 - img / box) / 2 * 100000)
                crop = f'<a:srcRect t="{cut}" b="{cut}"/>'
        else:                                                  # shrink the box to the image ratio, centred
            s = min(w / iw, h / ih)
            nw, nh = iw * s, ih * s
            x, y, w, h = x + (w - nw) / 2, y + (h - nh) / 2, nw, nh
        rid, i = self.deck.media(p, self), self._id()
        geom = (f'<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {int(min(50000, radius / max(1, min(w, h)) * 100000))}"/></a:avLst></a:prstGeom>'
                if radius else '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>')
        self.shapes.append(f'<p:pic><p:nvPicPr><p:cNvPr id="{i}" name="Picture {i}" descr="{escape(p.name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
                           f'<p:blipFill><a:blip r:embed="{rid}"/>{crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{self._xfrm(x, y, w, h)}{geom}</p:spPr></p:pic>')

    def xml(self) -> str:
        bg = _hex(self.deck.theme["bg"])
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{bg}"/></a:solidFill>'
                f'<a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/>'
                f'<a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{"".join(self.shapes)}</p:spTree></p:cSld>'
                f'<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')


class Deck:
    def __init__(self, spec: dict, base: Path):
        self.spec, self.base = spec, Path(base)
        self.theme = {**DEFAULT_THEME, **{k: v for k, v in (spec.get("theme") or {}).items() if v}}
        for k in ("bg", "fg", "muted", "accent", "accent2", "good", "bad"):
            self.theme[k] = _hex(self.theme[k])
        self.surface = _mix(self.theme["bg"], self.theme["fg"], 0.07)
        self.line = _mix(self.theme["bg"], self.theme["fg"], 0.16)
        self.slides: list[_Slide] = []
        self.files: dict[str, bytes] = {}
        self._media: dict[str, str] = {}

    def resolve(self, path) -> Path:
        p = Path(str(path))
        p = p if p.is_absolute() else self.base / p
        if not p.is_file():
            raise FileNotFoundError(f"image not found: {path}")
        return p

    def media(self, p: Path, slide: _Slide) -> str:
        key = str(p.resolve())
        if key not in self._media:
            ext = "jpg" if p.suffix.lower() in (".jpg", ".jpeg") else p.suffix.lower().lstrip(".")
            if ext not in ("png", "jpg", "gif"):
                raise ValueError(f"unsupported image type {p.suffix}: use PNG or JPEG")
            name = f"image{len(self._media) + 1}.{ext}"
            self._media[key] = name
            self.files[f"ppt/media/{name}"] = p.read_bytes()
        rid = f"rId{len(slide.rels) + 2}"
        slide.rels.append((rid, self._media[key]))
        return rid

    # ----------------------------------------------------------- layouts
    def _chrome(self, s: _Slide, n: int, total: int) -> None:
        th = self.theme
        s.text(M, H - 70, 900, 30, self.spec.get("title", ""), size=18, color=th["muted"])
        s.text(W - M - 300, H - 70, 300, 30, f"{n:02d} / {total:02d}", size=18, color=th["muted"], align="r")

    def _heading(self, s: _Slide, d: dict, width: float = W - 2 * M) -> float:
        th = self.theme
        y = 92
        if d.get("kicker"):
            s.text(M, y, width, 30, str(d["kicker"]).upper(), size=20, color=th["accent"], bold=True)
            y += 44
        s.text(M, y, width, 130, d.get("title", ""), size=54, heading=True, bold=True, spacing=0.95, max_lines=2)
        s.rect(M, y + 150, 96, 6, th["accent"], radius=3)
        return y + 196

    def _bullets(self, s: _Slide, items, x, y, w, size: float = 30) -> float:
        th = self.theme
        for it in (items or [])[:7]:
            text = it if isinstance(it, str) else str(it.get("text", ""))
            lines = max(1, -(-len(text) // max(8, int(w / (size * 0.5)))))
            s.rect(x, y + size * 0.52, 12, 12, th["accent"], radius=6)
            s.text(x + 38, y, w - 38, lines * size * 1.3 + 8, text, size=size, spacing=1.12)
            y += lines * size * 1.3 + 26
        return y

    def _takeaway(self, s: _Slide, text: str) -> None:
        if not text:
            return
        th = self.theme
        s.rect(M, H - 208, W - 2 * M, 96, self.surface, radius=18)
        s.rect(M, H - 208, 10, 96, th["accent"], radius=5)
        s.text(M + 42, H - 208, W - 2 * M - 80, 96, text, size=27, anchor="ctr", max_lines=2)

    def build(self) -> None:
        th, slides = self.theme, self.spec.get("slides") or []
        if not slides:
            raise ValueError("spec has no slides")
        for n, d in enumerate(slides, 1):
            s = _Slide(self)
            layout = str(d.get("layout", "bullets")).lower()
            if layout in ("title", "closing"):
                if d.get("image"):
                    s.image(d["image"], 0, 0, W, H, fit="cover")
                    s.rect(0, 0, W, H, th["bg"], alpha=0.72)
                s.rect(M, 330, 10, 330, th["accent"], radius=5)
                if d.get("kicker"):
                    s.text(M + 50, 330, 1500, 34, str(d["kicker"]).upper(), size=22, color=th["accent"], bold=True)
                s.text(M + 50, 384, 1560, 200, d.get("title", ""), size=92, heading=True, bold=True, spacing=0.92, max_lines=2)
                s.text(M + 50, 600, 1400, 110, d.get("subtitle", ""), size=34, color=th["muted"], spacing=1.15, max_lines=2)
                if d.get("footer"):
                    s.text(M + 50, H - 150, 1400, 34, d["footer"], size=22, color=th["muted"])
            elif layout == "section":
                s.text(M, 250, 700, 300, str(d.get("kicker", f"{n:02d}")), size=230, color=_mix(th["bg"], th["accent"], 0.55), heading=True, bold=True)
                s.text(M, 560, 1560, 160, d.get("title", ""), size=76, heading=True, bold=True, spacing=0.95, max_lines=2)
                s.text(M, 740, 1400, 100, d.get("subtitle", ""), size=32, color=th["muted"], max_lines=2)
                self._chrome(s, n, len(slides))
            elif layout == "kpis":
                y = self._heading(s, d)
                kpis = (d.get("kpis") or [])[:4]
                y += max(0, ((H - (230 if d.get("takeaway") else 130)) - y - 340) / 2 - 30)      # centre the card row in the free space
                gap, cw = 32, (W - 2 * M - 32 * (max(1, len(kpis)) - 1)) / max(1, len(kpis))
                has_delta = any(str(k.get("delta", "")).strip() for k in kpis)
                ch = 330 if has_delta else 262
                vsize = 74.0                                    # the longest value decides the size for every card
                longest = max((len(str(k.get("value", ""))) for k in kpis), default=1)
                while vsize > 30 and longest * vsize * 0.56 > cw - 80:
                    vsize *= 0.95
                y += (330 - ch) / 2
                for i, k in enumerate(kpis):
                    x = M + i * (cw + gap)
                    s.rect(x, y + 10, cw, ch, self.surface, radius=26)
                    s.rect(x, y + 10, cw, 8, th["accent"] if i % 2 == 0 else th["accent2"], radius=4)
                    s.text(x + 40, y + 62, cw - 80, 40, str(k.get("label", "")).upper(), size=21, color=th["muted"], bold=True)
                    s.text(x + 40, y + 118, cw - 80, 110, str(k.get("value", "")), size=vsize, heading=True, bold=True)
                    delta = str(k.get("delta", ""))
                    if delta:
                        col = th["bad"] if delta.strip().startswith(("-", "−", "▼")) else th["good"]
                        s.text(x + 40, y + 248, cw - 80, 44, delta, size=27, color=col, bold=True)
                self._takeaway(s, d.get("takeaway", ""))
                self._chrome(s, n, len(slides))
            elif layout in ("image", "chart"):
                if d.get("full"):
                    s.image(d["image"], 0, 0, W, H, fit="cover")
                else:
                    y = self._heading(s, d)
                    bottom = H - (150 if d.get("caption") else 110)
                    s.image(d["image"], M, y, W - 2 * M, bottom - y, radius=20)
                    if d.get("caption"):
                        s.text(M, bottom + 16, W - 2 * M, 34, d["caption"], size=22, color=th["muted"])
                    self._chrome(s, n, len(slides))
            elif layout == "two_col":
                y = self._heading(s, d)
                cw = (W - 2 * M - 64) / 2
                for i, col in enumerate((d.get("left") or {}, d.get("right") or {})):
                    x = M + i * (cw + 64)
                    s.rect(x, y, cw, H - y - 130, self.surface, radius=24)
                    s.text(x + 44, y + 40, cw - 88, 50, col.get("heading", ""), size=32, color=th["accent"] if i == 0 else th["accent2"], bold=True, heading=True)
                    self._bullets(s, col.get("bullets"), x + 44, y + 124, cw - 88, size=30)
                self._chrome(s, n, len(slides))
            elif layout == "quote":
                s.rect(M, 300, 12, 400, th["accent"], radius=6)
                s.text(M + 70, 290, 1500, 420, d.get("text", ""), size=58, heading=True, spacing=1.12, anchor="ctr", max_lines=5)
                s.text(M + 70, 740, 1400, 44, d.get("by", ""), size=26, color=th["muted"])
                self._chrome(s, n, len(slides))
            else:                                               # bullets (optionally with a picture on the right)
                has_img = bool(d.get("image"))
                y = self._heading(s, d, width=(W - 2 * M) if not has_img else 860)
                tw = (W - 2 * M) if not has_img else 800
                self._bullets(s, d.get("bullets"), M, y, tw)
                if has_img:
                    bx, bw, by, bh = M + 880, W - 2 * M - 880, 110, H - 110 - (230 if d.get("takeaway") else 130)
                    s.image(d["image"], bx, by, bw, bh, radius=20)
                self._takeaway(s, d.get("takeaway", ""))
                self._chrome(s, n, len(slides))
            self.slides.append(s)

    # ------------------------------------------------------------ package
    def save(self, out: Path) -> None:
        if not self.slides:
            self.build()
        th, n = self.theme, len(self.slides)
        rel = lambda items: ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                             + "".join(f'<Relationship Id="{i}" Type="{REL}/{t}" Target="{target}"/>' for i, t, target in items) + "</Relationships>")
        f = self.files
        exts = sorted({name.rsplit(".", 1)[1] for name in self._media.values()})
        mime = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif"}
        f["[Content_Types].xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                                    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                                    + "".join(f'<Default Extension="{e}" ContentType="{mime[e]}"/>' for e in exts)
                                    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                                    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
                                    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
                                    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
                                    + "".join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, n + 1))
                                    + "</Types>")
        f["_rels/.rels"] = rel([("rId1", "officeDocument", "ppt/presentation.xml")])
        f["ppt/presentation.xml"] = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
                                     '<p:sldIdLst>' + "".join(f'<p:sldId id="{255 + i}" r:id="rId{i + 1}"/>' for i in range(1, n + 1)) + '</p:sldIdLst>'
                                     f'<p:sldSz cx="{W * EMU}" cy="{H * EMU}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
        f["ppt/_rels/presentation.xml.rels"] = rel([("rId1", "slideMaster", "slideMasters/slideMaster1.xml")]
                                                   + [(f"rId{i + 1}", "slide", f"slides/slide{i}.xml") for i in range(1, n + 1)]
                                                   + [(f"rId{n + 2}", "theme", "theme/theme1.xml")])
        tree = ('<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
                '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>')
        f["ppt/slideMasters/slideMaster1.xml"] = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>{tree}</p:cSld>'
                                                  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
                                                  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>')
        f["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rel([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")])
        f["ppt/slideLayouts/slideLayout1.xml"] = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {NS} type="blank" preserve="1"><p:cSld name="Blank">{tree}</p:cSld>'
                                                  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>')
        f["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = rel([("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")])
        clr = lambda tag, v: f'<a:{tag}><a:srgbClr val="{v}"/></a:{tag}>'
        fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
        lines = "".join(f'<a:ln w="{w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' for w in (6350, 12700, 19050))
        font = lambda tag, face: f'<a:{tag}><a:latin typeface="{escape(face)}"/><a:ea typeface=""/><a:cs typeface=""/></a:{tag}>'
        f["ppt/theme/theme1.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Hangar"><a:themeElements>'
                                     '<a:clrScheme name="Hangar">' + clr("dk1", th["fg"]) + clr("lt1", th["bg"]) + clr("dk2", th["muted"]) + clr("lt2", self.surface)
                                     + clr("accent1", th["accent"]) + clr("accent2", th["accent2"]) + clr("accent3", th["good"]) + clr("accent4", th["bad"])
                                     + clr("accent5", th["muted"]) + clr("accent6", self.line) + clr("hlink", th["accent"]) + clr("folHlink", th["accent2"]) + '</a:clrScheme>'
                                     '<a:fontScheme name="Hangar">' + font("majorFont", th["heading_font"]) + font("minorFont", th["font"]) + '</a:fontScheme>'
                                     f'<a:fmtScheme name="Hangar"><a:fillStyleLst>{fills}</a:fillStyleLst><a:lnStyleLst>{lines}</a:lnStyleLst>'
                                     '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
                                     f'<a:bgFillStyleLst>{fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>')
        for i, s in enumerate(self.slides, 1):
            f[f"ppt/slides/slide{i}.xml"] = s.xml()
            f[f"ppt/slides/_rels/slide{i}.xml.rels"] = rel([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]
                                                             + [(rid, "image", f"../media/{name}") for rid, name in s.rels])
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", f.pop("[Content_Types].xml"))     # must be the first entry
            for name, data in f.items():
                z.writestr(name, data)


def build(spec: dict, out: Path, base: Path | None = None) -> dict:
    deck = Deck(spec, base or Path.cwd())
    deck.build()
    deck.save(Path(out))
    return {"slides": len(deck.slides), "images": len(deck._media), "path": str(out)}
