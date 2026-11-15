"""留白的图标：宣纸上一笔圆，上面留一个缺口——留白。

逐根笔毛画：每根笔毛沿着同一条路径走，墨量各不相同，快到笔尾时墨少的先断，自然出现飞白。

    python packaging/make_icon.py      # 生成 packaging/liubai.ico 和 packaging/liubai.png
"""
import math, os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
PAPER = np.array([250, 248, 243], float)
INK = np.array([22, 21, 19], float)


def noise(seed, scale, size=S):
    rng = np.random.default_rng(seed)
    small = rng.random((size // scale + 2, size // scale + 2))
    return np.array(Image.fromarray((small * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC), float) / 255


def brush(seed=7, R=.285, width=.13, start=-52, sweep=318, cx=.5, cy=.515):
    rnd = random.Random(seed)
    acc = np.zeros((S, S), float)
    cxp, cyp, Rp, Wp = cx * S, cy * S, R * S, width * S
    n_bristles = 70
    steps = 1400
    for b in range(n_bristles):
        off = (b / (n_bristles - 1) - .5)                 # -0.5..0.5 横跨笔宽
        ink = rnd.uniform(.72, 1.0) - abs(off) * .45       # 边上的笔毛墨少
        lay = Image.new("L", (S, S), 0)
        d = ImageDraw.Draw(lay)
        prev = None
        for i in range(steps):
            t = i / steps
            # 笔宽：起笔按下，中段饱满，收笔渐细
            press = min(1, t / .06) ** .5 * (1 - .62 * t ** 2.2)
            ang = math.radians(start + sweep * t)
            wob = 5 * math.sin(t * 7 + 1) + 3 * math.sin(t * 19)
            r = Rp + wob + off * Wp * press
            x, y = cxp + r * math.cos(ang), cyp + r * math.sin(ang)
            # 墨用完：墨少的笔毛先断
            left = ink - t * 1.05 - .08 * math.sin(t * 40 + b)
            if left > 0:
                if prev:
                    d.line((prev, (x, y)), fill=255, width=max(2, int(Wp / n_bristles * 2.4 * press + 2)))
                prev = (x, y)
            else:
                prev = None
        acc = np.maximum(acc, np.array(lay, float) / 255 * min(1, ink + .25))
    acc = np.array(Image.fromarray((acc * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6)), float) / 255
    # 起笔处墨多，稍微晕开一点
    yy, xx = np.mgrid[0:S, 0:S]
    a0 = math.radians(start + 4)
    sx, sy = cxp + Rp * math.cos(a0), cyp + Rp * math.sin(a0)
    blob = np.exp(-(((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * (Wp * .55) ** 2)))
    bleed = np.array(Image.fromarray((acc * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10)), float) / 255
    acc = np.maximum(acc, bleed * .22 + blob * bleed * .3)
    return np.clip(acc, 0, 1)


def render(a, tile=True):
    grain = noise(3, 2) * .5 + noise(4, 12) * .5
    paper = PAPER[None, None, :] - (noise(1, 5)[..., None] - .5) * 7 - (noise(2, 60)[..., None] - .5) * 6
    alpha = np.clip(a * (.86 + .14 * grain), 0, 1)
    tone = INK[None, None, :] + (1 - a[..., None]) * 40      # 淡的地方偏灰
    img = paper * (1 - alpha[..., None]) + tone * alpha[..., None]
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).convert("RGBA")
    if tile:
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle((36, 36, S - 36, S - 36), radius=210, fill=255)
        im.putalpha(m)
        ImageDraw.Draw(im).rounded_rectangle((36, 36, S - 36, S - 36), radius=210, outline=(214, 210, 202, 255), width=5)
    else:  # 没有底：只有墨（小尺寸、浅色背景上用）
        im.putalpha(Image.fromarray((alpha * 255).astype(np.uint8)))
    return im


if __name__ == "__main__":
    big = render(brush())
    # 小尺寸单独画：笔更粗、更圆，16 px 也认得出
    small = render(brush(seed=7, R=.27, width=.20))
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "liubai.png"))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    imgs = [(small if s <= 32 else big).resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[-1].save(os.path.join(HERE, "liubai.ico"), format="ICO", sizes=[(s, s) for s in sizes],
                  append_images=imgs[:-1])
    print("ok")
