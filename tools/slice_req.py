from PIL import Image

SRC = r"C:\Users\71412\.dsh\attachments\v1\objects\cb\cb1d65ceefb6d5bb520639acd07c15f83114de623c4e000f6478dbe4a08aeef9"
OUT = r"D:\jiaowolu\req_slices"

import os
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC)
W, H = im.size
print("size", W, H)

N = 8
step = H // N
for i in range(N):
    top = i * step
    bottom = H if i == N - 1 else (i + 1) * step
    part = im.crop((0, top, W, bottom))
    # upscale 4x for legibility
    part = part.resize((W * 4, (bottom - top) * 4), Image.LANCZOS)
    p = os.path.join(OUT, f"part{i+1:02d}.png")
    part.save(p)
    print(p, part.size)
