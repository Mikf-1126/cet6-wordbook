"""生成扩展图标：香槟金圆角方块 + 白色「译」字。

用法（在 CET6-WordBook-dev 目录下）：
    python make_icons.py

默认输出到 ~/CET6-WordBook/icons/。扩展目录不在默认位置时用环境变量指定：
    WB_EXT=D:/somewhere/MyExt python make_icons.py

注意：扩展目录内不能出现任何以下划线开头的文件（Chrome/Edge 保留前缀），
所以本脚本必须放在扩展目录之外。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

EXT_DIR = os.environ.get("WB_EXT") or os.path.join(os.path.expanduser("~"), "CET6-WordBook")
OUT = os.path.join(EXT_DIR, "icons")

ACCENT = (201, 169, 106, 255)   # #C9A96A
WHITE = (255, 255, 255, 255)

SS = 8  # 超采样倍数，先画大图再缩小，边缘才平滑

FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
)


def rounded(size, radius_ratio):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=ACCENT)

    glyph = "译"
    target = S * 0.66
    font = None
    for path in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        lo, hi = 4, int(S)
        while lo < hi:                      # 二分找能塞进 66% 画布的最大字号
            mid = (lo + hi + 1) // 2
            try:
                f = ImageFont.truetype(path, mid)
            except Exception:
                break
            box = d.textbbox((0, 0), glyph, font=f)
            if (box[2] - box[0]) <= target and (box[3] - box[1]) <= target:
                lo = mid
            else:
                hi = mid - 1
        font = ImageFont.truetype(path, lo)
        break

    if font is not None:
        box = d.textbbox((0, 0), glyph, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        d.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1]), glyph, font=font, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.isdir(EXT_DIR):
        print("找不到扩展目录：" + EXT_DIR)
        print("用 WB_EXT=<路径> 指定。")
        return 1

    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128, 256):
        path = os.path.join(OUT, "icon%d.png" % s)
        rounded(s, 0.22).save(path)
        print("wrote " + path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
