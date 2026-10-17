"""Render MeshDrop's existing icon geometry to PWA PNG sizes (optional: Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[2] / 'apps/web/public'
for name, size, maskable in [('icon-192.png',192,False),('icon-512.png',512,False),('apple-touch-icon.png',180,False),('icon-maskable-512.png',512,True)]:
    scale=16
    image=Image.new('RGBA',(64*scale,64*scale),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    if maskable: draw.rectangle((0,0,64*scale,64*scale),fill='#123d37')
    else: draw.rounded_rectangle((0,0,64*scale-1,64*scale-1),radius=16*scale,fill='#123d37')
    points=[(18,41),(18,23),(32,35),(46,23),(46,41)] if maskable else [(16,42),(16,22),(32,36),(48,22),(48,42)]
    draw.line([(x*scale,y*scale) for x,y in points],fill='#d6edab',width=(4 if maskable else 5)*scale,joint='curve')
    image.resize((size,size),Image.Resampling.LANCZOS).save(root/name)
