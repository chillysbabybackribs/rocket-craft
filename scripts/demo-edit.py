#!/usr/bin/env python3
"""Turn a demo recording (scripts/demo-video.mjs) into the finished video.

The recording is the app's real pixels at twice the window's size; events.json says when and
where things happened. This adds a camera that eases between the places the events name, a
pointer for the user's clicks, outlines on fields the agent filled in one script, and captions.
Frames are only cropped and resampled (PIL), never redrawn. Chunks render in parallel and are
joined without re-encoding.

  python3 scripts/demo-edit.py <run directory>   ->   <run directory>/demo.mp4
"""
import json
import math
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_W, OUT_H, FPS = 1920, 1080, 60
SRC_FPS = 30
EASE_CAMERA = 1.1
MAX_ZOOM = 2.3
ACCENT = (124, 92, 255)
FONT = os.path.expanduser('~/.local/share/fonts/inter-var.ttf')
FALLBACK_FONT = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'


def ease(x):
    x = min(1.0, max(0.0, x))
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def lerp(a, b, k):
    return a + (b - a) * k


class Timeline:
    def __init__(self, data):
        self.W, self.H = data['width'], data['height']
        self.events = data['events']
        self.end = next(e['t'] for e in self.events if e['kind'] == 'end')
        self.cameras = []
        self.points = []
        self.clicks = []
        self.hides = []
        self.fills = []
        self.captions = []
        for e in self.events:
            k = e['kind']
            if k == 'camera':
                self.cameras.append((e['t'], self.rect(e.get('box'), e.get('pad', 1.25))))
            elif k == 'point':
                self.points.append(e)
            elif k == 'click':
                self.clicks.append(e)
            elif k == 'hide-pointer':
                self.hides.append(e['t'])
            elif k == 'fill':
                self.fills.append(e)
            elif k == 'caption':
                self.captions.append(e)

    def rect(self, box, pad):
        """The 16:9 source rectangle that shows a box with room around it."""
        if not box:
            return (0.0, 0.0, float(self.W), float(self.H))
        cx, cy = box['x'] + box['w'] / 2, box['y'] + box['h'] / 2
        w = max(box['w'] * pad, box['h'] * pad * 16 / 9, self.W / MAX_ZOOM)
        w = min(w, self.W)
        h = w * 9 / 16
        if h > self.H:
            h, w = self.H, self.H * 16 / 9
        # Sit the subject a little above centre, clear of the captions along the bottom.
        cy += h * 0.08
        x = min(max(cx - w / 2, 0), self.W - w)
        y = min(max(cy - h / 2, 0), self.H - h)
        return (x, y, w, h)

    def camera(self, t):
        current = (0.0, 0.0, float(self.W), float(self.H))
        for i, (start, target) in enumerate(self.cameras):
            if start > t:
                break
            # A move starts from wherever the last one had got to, finished or not.
            stop = min(t, self.cameras[i + 1][0]) if i + 1 < len(self.cameras) else t
            k = ease((stop - start) / EASE_CAMERA)
            current = tuple(lerp(a, b, k) for a, b in zip(current, target))
        return current

    def pointer(self, t):
        """(x, y, alpha, press) in source pixels, or None while hidden."""
        moves = [p for p in self.points if p['t'] <= t]
        if not moves:
            return None
        last_hide = max([h for h in self.hides if h <= t], default=-1)
        if last_hide > moves[-1]['t']:
            fade = 1 - (t - last_hide) / 0.35
            if fade <= 0:
                return None
            x, y = self._pointer_at(last_hide, moves)
            return (x, y, fade, 0)
        x, y = self._pointer_at(t, moves)
        # Fade in when it appears after being hidden.
        shown_from = moves[0]['t'] if last_hide < 0 else min(p['t'] for p in moves if p['t'] > last_hide)
        alpha = min(1.0, (t - shown_from) / 0.25)
        press = 0.0
        for c in self.clicks:
            if 0 <= t - c['t'] < 0.22:
                press = math.sin(math.pi * (t - c['t']) / 0.22)
        return (x, y, alpha, press)

    def _pointer_at(self, t, moves):
        x = y = None
        for i, p in enumerate(moves):
            following_click = next((c for c in self.clicks if c['t'] >= p['t']), None)
            duration = max(0.3, min(0.75, (following_click['t'] - p['t']) if following_click else 0.6))
            if x is None:
                # Appear a little below and right of the first target, then glide in.
                x, y = p['x'] + 260, p['y'] + 200
            k = ease_out((t - p['t']) / duration) if t < p['t'] + duration else 1
            x, y = lerp(x, p['x'], k), lerp(y, p['y'], k)
        return x, y


def font(size, weight=650):
    try:
        f = ImageFont.truetype(FONT, size)
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
        return f
    except OSError:
        return ImageFont.truetype(FALLBACK_FONT, size)


def caption_image(text):
    f = font(34, 600)
    pad_x, pad_y = 34, 18
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=f)
    w, h = right - left + pad_x * 2, 34 + pad_y * 2
    shadow = 24
    image = Image.new('RGBA', (w + shadow * 2, h + shadow * 2), (0, 0, 0, 0))
    shade = Image.new('RGBA', image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shade).rounded_rectangle((shadow, shadow + 6, shadow + w, shadow + h + 6), radius=h // 2, fill=(0, 0, 0, 120))
    image = Image.alpha_composite(image, shade.filter(ImageFilter.GaussianBlur(12)))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((shadow, shadow, shadow + w, shadow + h), radius=h // 2, fill=(18, 19, 28, 232), outline=(255, 255, 255, 38), width=2)
    draw.ellipse((shadow + 18, shadow + h // 2 - 6, shadow + 30, shadow + h // 2 + 6), fill=ACCENT + (255,))
    draw.text((shadow + pad_x + 8 - left, shadow + pad_y - top + 2), text, font=f, fill=(245, 246, 250, 255))
    return image


def pointer_image(scale):
    """A plain arrow pointer: white with a dark edge and a soft shadow."""
    s = 4  # draw large, then shrink, for clean edges
    shape = [(0, 0), (0, 25), (6, 19), (10.5, 29), (14.5, 27.5), (10, 18), (18, 18)]
    pts = [(x * s * scale + 8 * s, y * s * scale + 8 * s) for x, y in shape]
    size = (int(40 * s * scale), int(48 * s * scale))
    shadow = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 2 * s, y + 3 * s) for x, y in pts], fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(3 * s))
    arrow = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(arrow)
    d.polygon(pts, fill=(255, 255, 255, 255))
    d.line(pts + [pts[0]], fill=(20, 20, 24, 255), width=int(1.6 * s * scale), joint='curve')
    image = Image.alpha_composite(shadow, arrow)
    return image.resize((size[0] // s, size[1] // s), Image.LANCZOS), (8 * scale, 8 * scale)


def with_alpha(image, alpha):
    if alpha >= 0.999:
        return image
    a = np.asarray(image).copy()
    a[..., 3] = (a[..., 3].astype(np.float32) * alpha).astype(np.uint8)
    return Image.fromarray(a, 'RGBA')


def render_chunk(args):
    run, sync, start, end, index, data = args
    tl = Timeline(data)
    W, H = tl.W, tl.H
    captions = {c['text']: caption_image(c['text']) for c in tl.captions}
    pointer, hotspot = pointer_image(1.25)
    src_start = sync + start
    decoder = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-ss', f'{src_start:.4f}', '-i', os.path.join(run, 'raw.mp4'),
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    path = os.path.join(run, f'chunk-{index:03d}.mp4')
    encoder = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OUT_W}x{OUT_H}', '-r', str(FPS), '-i', '-',
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], stdin=subprocess.PIPE)
    frame_bytes = W * H * 3
    src_index = -1
    src = None
    first_src = round(src_start * SRC_FPS)
    n = round(start * FPS)
    while n / FPS < end:
        t = n / FPS
        want = math.floor((sync + t) * SRC_FPS + 1e-6) - first_src
        # Rounding at a chunk's edge can ask for the frame before its first; use the first.
        while src_index < max(want, 0):
            raw = decoder.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            src = raw
            src_index += 1
        image = Image.frombuffer('RGB', (W, H), src, 'raw', 'RGB', 0, 1)
        x, y, w, h = tl.camera(t)
        frame = image.resize((OUT_W, OUT_H), Image.BICUBIC, box=(x, y, x + w, y + h)).convert('RGBA')
        k = OUT_W / w

        def to_out(px, py):
            return (px - x) * k, (py - y) * k

        overlay = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # Fields the agent filled in one call: outlined together, at once.
        for fill in tl.fills:
            age = t - fill['t']
            if 0 <= age < 2.6:
                alpha = min(1, age / 0.18) * (1 if age < 1.9 else 1 - (age - 1.9) / 0.7)
                grow = 6 * (1 - ease_out(age / 0.35))
                for b in fill['boxes']:
                    x0, y0 = to_out(b['x'], b['y'])
                    x1, y1 = to_out(b['x'] + b['w'], b['y'] + b['h'])
                    rect = (x0 - 5 - grow, y0 - 5 - grow, x1 + 5 + grow, y1 + 5 + grow)
                    draw.rounded_rectangle(rect, radius=14, fill=ACCENT + (int(26 * alpha),), outline=ACCENT + (int(255 * alpha),), width=4)
        # Click ripples.
        for c in tl.clicks:
            age = t - c['t']
            if 0 <= age < 0.55:
                cx, cy = to_out(c['x'], c['y'])
                r = 10 + 46 * ease_out(age / 0.55)
                a = int(200 * (1 - age / 0.55))
                draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, a), width=4)
                draw.ellipse((cx - r * 0.55, cy - r * 0.55, cx + r * 0.55, cy + r * 0.55), fill=ACCENT + (a // 3,))
        frame = Image.alpha_composite(frame, overlay)
        p = tl.pointer(t)
        if p:
            px, py = to_out(p[0], p[1])
            scale = 1 - 0.12 * p[3]
            sprite = pointer if scale == 1 else pointer.resize((int(pointer.width * scale), int(pointer.height * scale)), Image.LANCZOS)
            sprite = with_alpha(sprite, p[2])
            frame.alpha_composite(sprite, (int(px - hotspot[0] * scale), int(py - hotspot[1] * scale)))
        for c in tl.captions:
            age = t - c['t']
            if 0 <= age < c['dur']:
                alpha = min(1, age / 0.3, (c['dur'] - age) / 0.3)
                image_c = captions[c['text']]
                lift = int(14 * (1 - ease_out(min(1, age / 0.35))))
                frame.alpha_composite(with_alpha(image_c, alpha), ((OUT_W - image_c.width) // 2, OUT_H - image_c.height - 34 + lift))
        out = frame.convert('RGB')
        # Fade from and to black at the ends.
        fade = min(1, t / 0.5, (tl.end - t) / 0.6)
        if fade < 1:
            out = Image.fromarray((np.asarray(out).astype(np.float32) * max(0, fade)).astype(np.uint8))
        encoder.stdin.write(out.tobytes())
        n += 1
    encoder.stdin.close()
    encoder.wait()
    decoder.kill()
    return path


def find_sync(run):
    """Seconds into raw.mp4 when the magenta flash ended, which is t = 0 of events.json."""
    w, h = 32, 18
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(run, 'raw.mp4'), '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    # The shell's chat column, left of the browser view the flash cannot cover.
    probe = frames[:, 9, 8].astype(int)
    magenta = np.where((probe[:, 0] > 200) & (probe[:, 1] < 80) & (probe[:, 2] > 200))[0]
    if not len(magenta):
        sys.exit('No sync flash was found in raw.mp4. Record again with scripts/demo-video.mjs.')
    return (magenta[-1] + 1) / SRC_FPS


def main():
    run = os.path.abspath(sys.argv[1])
    data = json.load(open(os.path.join(run, 'events.json')))
    sync = find_sync(run)
    end = Timeline(data).end
    workers = max(1, (os.cpu_count() or 4) - 2)
    bounds = np.linspace(0, end, workers + 1)
    # Chunk edges on whole output frames so no frame is drawn twice or skipped.
    edges = [round(b * FPS) / FPS for b in bounds]
    jobs = [(run, sync, edges[i], edges[i + 1], i, data) for i in range(workers)]
    with ProcessPoolExecutor(workers) as pool:
        chunks = list(pool.map(render_chunk, jobs))
    listing = os.path.join(run, 'chunks.txt')
    with open(listing, 'w') as f:
        f.writelines(f"file '{c}'\n" for c in chunks)
    out = os.path.join(run, 'demo.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', '-movflags', '+faststart', out], check=True)
    for c in chunks:
        os.remove(c)
    os.remove(listing)
    print(out)


if __name__ == '__main__':
    main()
