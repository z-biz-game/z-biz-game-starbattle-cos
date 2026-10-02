#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_art.py — 双星 Star Battle 的美术资产生成器（纯标准库 + zlib，无第三方依赖）。

为什么自己写：官方 make_icons.py 的图形母体表里没有本仓，会退化成通用的 `orbit`（行星环）——
那是"引力/轨道"游戏的语言，不是"每行每列每区两颗、任何两颗不能挨着"的双星推理。图标是品牌资产，
必须讲玩法自己的故事。母题（与本仓 js/theme.js 的令牌逐一对齐，杜绝两套色）：

    深空藏蓝底   bgTop #080B16 → bgBottom #131A2E，最深拉到近黑
    石板蓝区域线 regionBorder #8FA6CC —— 区域形状就是线索，给它最响的一笔
    琥珀双星     accent #FFC85C / accentEdge #FFE3A6 —— 玩家自己的手，两颗且互不相邻
    冷星尘       info #7BB8FF 微点 + 白点 —— 星空，也暗合 region 的冷色调

可复现：固定随机种子 + 固定 zlib level，同一份源码重跑产出逐字节一致的 PNG。
产出（相对仓库根）：
    icons/favicon-{16,32,48,64,96}.png        圆角 app 图标风
    icons/apple-touch-icon.png (180)          iOS：满幅无圆角（iOS 自己套圆角遮罩）
    icons/icon-{192,512,1024}.png             PWA/商店：圆角
    icons/icon-maskable-{192,512}.png         Android maskable：满幅 + 主体缩进安全区
    assets/og/starbattle-og.png (1200x630)    社交卡（横构图：星野 + 区域网格 + 双星）
    assets/textures/starfield.png (512)       游戏内背景纹理（平铺用的冷星野）

用法：python3 assets/gen/gen_art.py            # 从仓根或任意 cwd 运行都可
"""
import os
import struct
import zlib
import math

# ---------------------------------------------------------------------------- 路径
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

# ---------------------------------------------------------------------------- 调色（对齐 js/theme.js）
def _rgb(hexs):
    hexs = hexs.lstrip('#')
    return (int(hexs[0:2], 16), int(hexs[2:4], 16), int(hexs[4:6], 16))

BG_TOP    = _rgb('#080B16')
BG_BOTTOM = _rgb('#131A2E')
DEEP      = (4, 6, 12)
ACCENT    = _rgb('#FFC85C')
ACC_EDGE  = _rgb('#FFE3A6')
ACC_DEEP  = _rgb('#E0A63C')   # 琥珀的暗侧，做出球面体积
REGION    = _rgb('#8FA6CC')
INFO      = _rgb('#7BB8FF')
SUCCESS   = _rgb('#3DDC91')

SEED = 20261002

# ---------------------------------------------------------------------------- 工具
def lerp(a, b, t):
    return a + (b - a) * t


def mix(c0, c1, t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t))


def clamp(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


class Lcg:
    """线性同余随机：跨语言/跨平台可复现，绝不用 Math.random()/random 平台实现。"""
    def __init__(self, seed):
        self.s = seed & 0x7FFFFFFF
        if self.s == 0:
            self.s = 0x2F6E2B1

    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def range(self, a, b):
        return a + (b - a) * self.next()

    def randint(self, a, b):
        return int(self.range(a, b + 0.999999))


class Canvas:
    """RGBA 浮点缓冲（0..1），源码先画后一次性量化写盘。"""
    def __init__(self, w, h):
        self.w = w
        self.h = h
        self.buf = bytearray(w * h * 4)

    def clear(self, c, a=1.0):
        r = int(clamp(c[0]) * 255) if c[0] <= 1 else int(c[0])
        g = int(clamp(c[1]) * 255) if c[1] <= 1 else int(c[1])
        b = int(clamp(c[2]) * 255) if c[2] <= 1 else int(c[2])
        ab = int(clamp(a) * 255)
        px = bytes((r, g, b, ab))
        row = px * self.w
        for y in range(self.h):
            self.buf[y * self.w * 4:(y + 1) * self.w * 4] = row

    def _idx(self, x, y):
        return (y * self.w + x) * 4

    def get(self, x, y):
        i = self._idx(x, y)
        b = self.buf
        return (b[i], b[i + 1], b[i + 2], b[i + 3])

    def over(self, x, y, col, a=1.0):
        """source-over 合成（col 0..255，a 0..1）。"""
        if a <= 0 or x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        i = self._idx(x, y)
        b = self.buf
        da = b[i + 3] / 255.0
        na = a + da * (1 - a)
        if na <= 0:
            b[i] = b[i + 1] = b[i + 2] = b[i + 3] = 0
            return
        for k in range(3):
            src = col[k]
            dst = b[i + k]
            v = (src * a + dst * da * (1 - a)) / na
            b[i + k] = 0 if v < 0 else (255 if v > 255 else int(v))
        b[i + 3] = int(clamp(na) * 255)

    def add(self, x, y, col, amt):
        """加性叠光（用于星辉、星尘）：只加不透明 RGB，不改 alpha。"""
        if amt <= 0 or x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        i = self._idx(x, y)
        b = self.buf
        b[i] = min(255, b[i] + int(col[0] * amt))
        b[i + 1] = min(255, b[i + 1] + int(col[1] * amt))
        b[i + 2] = min(255, b[i + 2] + int(col[2] * amt))


# ---------------------------------------------------------------------------- PNG 编码（zlib，color type 6 RGBA，bit 8，filter 0）
def write_png(path, canvas):
    w, h = canvas.w, canvas.h
    stride = w * 4
    raw = bytearray()
    b = canvas.buf
    for y in range(h):
        raw.append(0)
        raw += b[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    out = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', comp) + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(out)
    return len(out)


# ---------------------------------------------------------------------------- 几何：五角星（顶点与 render/board.js 的 star() 同构）
def star_points(cx, cy, R, rot=0.0):
    pts = []
    inner = R * 0.44
    for i in range(10):
        a = -math.pi / 2 + (i * math.pi) / 5 + rot
        r = R if i % 2 == 0 else inner
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return pts


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------------------- 图层
def paint_background(cv, rnd, neb_c=REGION, glow=0.16, vertical=True):
    """深空底：竖向渐变 + 一枚柔和的冷色星云辉（中心偏上）。"""
    w, h = cv.w, cv.h
    for y in range(h):
        t = y / max(1, h - 1)
        base = mix(BG_TOP, BG_BOTTOM, t) if vertical else mix(DEEP, BG_BOTTOM, t)
        row = bytes((
            max(0, min(255, int(round(base[0])))),
            max(0, min(255, int(round(base[1])))),
            max(0, min(255, int(round(base[2])))),
            255))
        for x in range(w):
            i = cv._idx(x, y)
            cv.buf[i:i + 4] = row
    # 星云辉：以中心为峰的高斯加性光
    cx, cy = w * 0.5, h * 0.44
    sigma = max(w, h) * 0.34
    span = int(sigma * 2.2)
    for y in range(max(0, int(cy) - span), min(h, int(cy) + span)):
        for x in range(max(0, int(cx) - span), min(w, int(cx) + span)):
            d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (sigma * sigma)
            amt = glow * math.exp(-0.5 * d2)
            cv.add(x, y, neb_c, amt)


def paint_starfield(cv, rnd, count, twinkle=1.0, wrap=False):
    """星尘：按面积播种的白/冷/金微点。wrap=True 时把点同时镜像到对边，供无缝平铺。"""
    w, h = cv.w, cv.h
    for _ in range(count):
        x = rnd.range(0, w)
        y = rnd.range(0, h)
        bright = rnd.range(0.18, 1.0) ** 1.6
        roll = rnd.next()
        if roll < 0.14:
            col = ACC_EDGE
        elif roll < 0.34:
            col = INFO
        else:
            col = (236, 240, 250)
        r = rnd.range(0.4, 1.7) * twinkle
        offs = [(0, 0)]
        if wrap:
            offs = [(0, 0), (w, 0), (-w, 0), (0, h), (0, -h)]
        for ox, oy in offs:
            _dot(cv, x + ox, y + oy, r, col, bright)


def _dot(cv, fx, fy, r, col, bright):
    w, h = cv.w, cv.h
    ri = int(math.ceil(r + 1))
    cx0, cy0 = int(round(fx)), int(round(fy))
    for y in range(cy0 - ri, cy0 + ri + 1):
        if y < 0 or y >= h:
            continue
        for x in range(cx0 - ri, cx0 + ri + 1):
            if x < 0 or x >= w:
                continue
            d = math.hypot(x - fx, y - fy)
            if d <= r:
                a = bright * clamp(1 - d / (r + 1e-6))
                cv.add(x, y, col, a * 0.9)
            elif d <= r + 1.4:
                a = bright * clamp(1 - (d - r) / 1.4) * 0.5
                cv.add(x, y, col, a * 0.6)


def paint_regions(cv, size, rnd, divider_pts, width, col=REGION):
    """石板蓝区域分割线：折线，端点/拐角圆头。divider_pts 是 0..1 归一坐标。"""
    w, h = cv.w, cv.h
    pts = [(p[0] * w, p[1] * h) for p in divider_pts]
    hw = width / 2.0
    for i in range(len(pts) - 1):
        _segment(cv, pts[i], pts[i + 1], hw, col, 0.92)
    for p in pts:
        _disc(cv, p[0], p[1], hw, col, 0.92)


def _segment(cv, a, b, hw, col, alpha):
    w, h = cv.w, cv.h
    x0, y0 = a
    x1, y1 = b
    span = int(math.hypot(x1 - x0, y1 - y0)) + int(hw) + 2
    ux, uy = (x1 - x0), (y1 - y0)
    L = math.hypot(ux, uy) or 1.0
    ux, uy = ux / L, uy / L
    for s in range(0, span):
        px = x0 + ux * min(s, L)
        py = y0 + uy * min(s, L)
        # 沿线每步进，铺一个圆头截面（_disc 自带边缘反走样）
        _disc(cv, px, py, hw, col, alpha)


def _disc(cv, fx, fy, r, col, alpha):
    w, h = cv.w, cv.h
    ri = int(math.ceil(r)) + 1
    cx0, cy0 = int(round(fx)), int(round(fy))
    for y in range(cy0 - ri, cy0 + ri + 1):
        if y < 0 or y >= h:
            continue
        for x in range(cx0 - ri, cx0 + ri + 1):
            if x < 0 or x >= w:
                continue
            d = math.hypot(x - fx, y - fy)
            if d <= r:
                cv.over(x, y, col, alpha)
            elif d <= r + 1.0:
                cv.over(x, y, col, alpha * clamp(1 - (d - r)) * 0.9)


def draw_star(cv, cx, cy, R, rot=0.0, glow_amt=0.55, edge=True):
    """一颗琥珀星：外圈柔光 → 本体双色渐变 → 上左高光边缘。"""
    w, h = cv.w, cv.h
    poly = star_points(cx, cy, R, rot)
    # 1) 外辉
    gr = int(R * 1.9)
    sigma = R * 0.7
    for y in range(max(0, int(cy) - gr), min(h, int(cy) + gr)):
        for x in range(max(0, int(cx) - gr), min(w, int(cx) + gr)):
            d = math.hypot(x - cx, y - cy)
            if d > gr:
                continue
            amt = glow_amt * math.exp(-0.5 * (d / sigma) ** 2)
            if d < R * 0.95:
                continue  # 本体范围内交给 fill
            cv.add(x, y, ACCENT, amt * 0.5)
    # 2) 本体 + 边缘
    minx = max(0, int(cx - R) - 2)
    maxx = min(w, int(cx + R) + 2)
    miny = max(0, int(cy - R) - 2)
    maxy = min(h, int(cy + R) + 2)
    lx, ly = cx - R * 0.5, cy - R * 0.5  # 高光方向（左上）
    for y in range(miny, maxy):
        for x in range(minx, maxx):
            if not point_in_poly(x + 0.5, y + 0.5, poly):
                continue
            dx, dy = x - cx, y - cy
            dist = math.hypot(dx, dy) / R
            shade = mix(ACC_DEEP, ACCENT, clamp(0.25 + 0.75 * dist))
            hl = clamp(1 - math.hypot(x - lx, y - ly) / (R * 1.7))
            col = mix(shade, ACC_EDGE, hl * 0.6)
            # 边缘描线：接近星轮廓处提亮成 accentEdge
            if edge:
                near = False
                for vx, vy in poly:
                    if (vx - x) ** 2 + (vy - y) ** 2 < (max(1.5, R * 0.035)) ** 2:
                        near = True
                        break
                if near:
                    col = mix(col, ACC_EDGE, 0.8)
            cv.over(x, y, tuple(int(c) for c in col), 1.0)


def paint_grid(cv, n, pad, alpha, col=INFO):
    w, h = cv.w, cv.h
    gw = (w - 2 * pad) / n
    gh = (h - 2 * pad) / n
    for i in range(n + 1):
        x = int(pad + i * gw)
        _segment(cv, (x, int(pad)), (x, int(pad + n * gh)), 0.8, col, alpha)
        y = int(pad + i * gh)
        _segment(cv, (int(pad), y), (int(pad + n * gw), y), 0.8, col, alpha)


def apply_sheen(cv, seed):
    """斜向高光 + 细颗粒，让成套资产像同一个设计语言。"""
    w, h = cv.w, cv.h
    rnd = Lcg(seed + 991)
    for y in range(h):
        for x in range(w):
            # 一条从左上到右下的对角亮带
            d = (x / w) - (y / h)
            sheen = 0.10 * math.exp(-((d + 0.28) ** 2) / 0.02)
            grain = (rnd.next() - 0.5) * 0.035
            if sheen or grain:
                amt = sheen + grain
                c = cv.get(x, y)
                nb = 1.0 + amt
                cv.buf[cv._idx(x, y):cv._idx(x, y) + 3] = bytes((
                    min(255, int(c[0] * nb)), min(255, int(c[1] * nb)), min(255, int(c[2] * nb))))


def apply_vignette(cv, strength=0.5):
    w, h = cv.w, cv.h
    cx, cy = w / 2, h / 2
    rmax = math.hypot(cx, cy)
    for y in range(h):
        for x in range(w):
            d = math.hypot(x - cx, y - cy) / rmax
            f = 1 - strength * clamp((d - 0.55) / 0.45) ** 1.5
            i = cv._idx(x, y)
            b = cv.buf
            b[i] = int(b[i] * f)
            b[i + 1] = int(b[i + 1] * f)
            b[i + 2] = int(b[i + 2] * f)


def rounded_mask(cv, radius_frac):
    """把四角裁成圆角（app 图标风）。alpha 边缘反走样。"""
    w, h = cv.w, cv.h
    r = radius_frac * w

    def aa(px, py):
        # 到最近角圆心的带符号距离（外为正）
        cx = r if px < r else (w - r if px > w - r else None)
        cy = r if py < r else (h - r if py > h - r else None)
        if cx is None or cy is None:
            return 1.0  # 不在角区
        d = math.hypot(px - cx, py - cy)
        if d <= r - 1:
            return 1.0
        if d >= r + 1:
            return 0.0
        return clamp((r + 1 - d) / 2.0)

    for y in range(h):
        for x in range(w):
            a = aa(x + 0.5, y + 0.5)
            if a >= 1.0:
                continue
            i = cv._idx(x, y)
            cv.buf[i + 3] = int(cv.buf[i + 3] * a)


# ---------------------------------------------------------------------------- 母题构图
def app_icon(size, shape='rounded', subject_inset=1.0, seed=SEED):
    """方形母题：星野 + 石板蓝区域线 + 两颗不相邻的琥珀星。shape: rounded|full"""
    cv = Canvas(size, size)
    cv.clear((0, 0, 0), 0.0)
    rnd = Lcg(seed)
    paint_background(cv, rnd)
    paint_starfield(cv, rnd, int(size * size / 1400), twinkle=size / 512.0 * 1.2)
    u = size / 100.0
    # 区域分割线：一条不规则的“阶梯”边界（呼应双星盘上区域即线索）
    divider = [(0.06, 0.34), (0.40, 0.34), (0.40, 0.62), (0.74, 0.62), (0.74, 0.16)]
    paint_regions(cv, size, rnd, divider, width=max(2.4, u * 3.2), col=REGION)
    # 两颗星：左中 + 右下，斜向分离 → 视觉上“互不相邻”
    star_R = u * 13 * subject_inset
    draw_star(cv, size * 0.315, size * 0.60, star_R, rot=0.02, glow_amt=0.5)
    draw_star(cv, size * 0.685, size * 0.40, star_R, rot=-0.05, glow_amt=0.42)
    apply_sheen(cv, seed)
    apply_vignette(cv, 0.42 if shape == 'rounded' else 0.5)
    if shape == 'rounded':
        rounded_mask(cv, 0.225)
    return cv


def og_card(w=1200, h=630, seed=SEED):
    """社交卡：横构图。左二分之一放一颗大星 + 网格意象，右侧星野 + 区域线 + 次星。"""
    cv = Canvas(w, h)
    cv.clear((0, 0, 0), 0.0)
    rnd = Lcg(seed)
    paint_background(cv, rnd, neb_c=REGION, glow=0.14)
    paint_starfield(cv, rnd, int(w * h / 1100), twinkle=1.5)
    # 中部偏右：一个 5x5 的浅色区域网格，双星落在非相邻格上
    gx, gy, gsz = w * 0.50, h * 0.12, h * 0.76
    _grid_region(cv, gx, gy, gsz, 5, rnd)
    cell = gsz / 5.0
    draw_star(cv, gx + cell * 1.5, gy + cell * 2.5, cell * 0.40, glow_amt=0.55)
    draw_star(cv, gx + cell * 3.5, gy + cell * 3.5, cell * 0.40, glow_amt=0.45)  # (row3,col3)，与左上那颗不共边不共角
    apply_sheen(cv, seed)
    apply_vignette(cv, 0.38)
    return cv


def _grid_region(cv, ox, oy, size, n, rnd):
    w = cv.w
    cell = size / n
    # 粗网格（冷色低透明）暗示棋盘
    for i in range(n + 1):
        a = 0.16 if i % n == 0 else 0.08
        _segment(cv, (ox + i * cell, oy), (ox + i * cell, oy + size), 1.1, INFO, a)
        _segment(cv, (ox, oy + i * cell), (ox + size, oy + i * cell), 1.1, INFO, a)
    # 一条石板蓝区域线穿过网格，形状不规则
    pts = [(ox, oy + cell * 2), (ox + cell * 2, oy + cell * 2),
           (ox + cell * 2, oy + cell * 3), (ox + size, oy + cell * 3)]
    paint_regions(cv, size, rnd, [(p[0] / w, p[1] / cv.h) for p in pts],
                  width=max(2.0, cell * 0.10), col=REGION)


def starfield_tile(size=512, seed=SEED):
    """无缝平铺的冷星野纹理：无主体、弱全局明暗、点与星云都跨边镜像。"""
    cv = Canvas(size, size)
    cv.clear((0, 0, 0), 1.0)
    rnd = Lcg(seed)
    # 极浅的竖向渐变（两端同色，便于上下无缝）
    w, h = size, size
    for y in range(h):
        t = math.sin(y / h * math.pi)  # 0→1→0，顶/底同值 → 竖向无缝
        base = mix(DEEP, BG_BOTTOM, t * 0.8)
        row = bytes((int(base[0]), int(base[1]), int(base[2])))
        for x in range(w):
            cv.buf[cv._idx(x, y):cv._idx(x, y) + 3] = row
    # 两团星云，跨边镜像
    for nc, nr, na in [(REGION, 0.30, 0.10), (INFO, 0.22, 0.07)]:
        _nebula_wrap(cv, rnd.range(0.2, 0.8) * size, rnd.range(0.2, 0.8) * size, nr * size, nc, na)
    paint_starfield(cv, rnd, int(size * size / 900), twinkle=1.1, wrap=True)
    return cv


def _nebula_wrap(cv, cx, cy, sigma, col, glow):
    size = cv.w
    offs = [(0, 0), (size, 0), (-size, 0), (0, size), (0, -size),
            (size, size), (-size, -size), (size, -size), (-size, size)]
    span = int(sigma * 2.1)
    for y in range(int(cy) - span, int(cy) + span):
        yy = y % size
        for x in range(int(cx) - span, int(cx) + span):
            xx = x % size
            best = 0.0
            for ox, oy in offs:
                d2 = ((x + ox - cx) ** 2 + (y + oy - cy) ** 2) / (sigma * sigma)
                amt = glow * math.exp(-0.5 * d2)
                if amt > best:
                    best = amt
            if best > 0.001:
                cv.add(xx, yy, col, best)


# ---------------------------------------------------------------------------- 落盘清单
def build():
    files = []
    def emit(rel, cv):
        path = os.path.join(ROOT, rel)
        n = write_png(path, cv)
        files.append((rel, cv.w, cv.h, n))
        print('  %-40s %4dx%-4d %6.1f KB' % (rel, cv.w, cv.h, n / 1024))

    print('icons (favicon / apple-touch / pwa / maskable):')
    for s in (16, 32, 48, 64, 96):
        emit('icons/favicon-%d.png' % s, app_icon(s))
    emit('icons/apple-touch-icon.png', app_icon(180, shape='full'))  # iOS 自套圆角
    for s in (192, 512, 1024):
        emit('icons/icon-%d.png' % s, app_icon(s))
    for s in (192, 512):
        emit('icons/icon-maskable-%d.png' % s, app_icon(s, shape='full', subject_inset=0.80))
    print('og card:')
    emit('assets/og/starbattle-og.png', og_card())
    print('in-game texture:')
    emit('assets/textures/starfield.png', starfield_tile())
    return files


if __name__ == '__main__':
    fs = build()
    print('\n合计 %d 张 PNG，母题=深空双星（藏蓝底/石板蓝区域线/两颗不相邻琥珀星）。' % len(fs))
    print('仓库根: %s' % ROOT)
