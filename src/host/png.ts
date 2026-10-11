import { deflateSync, inflateSync } from 'node:zlib'

// Just enough PNG to shrink an app's screenshot in the agent host, where Electron's nativeImage is
// not available and main must not do the work: 8-bit grey, grey+alpha, RGB and RGBA, not
// interlaced, which is what the Craft apps write (checked on GridCraft 0.5.0 and PhotoCraft 0.7.0:
// 8-bit RGBA). Anything else is passed through unscaled rather than guessed at.

export type Png = { width: number; height: number; channels: number; pixels: Buffer }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** The image's size from its header, or null when the bytes are not a PNG. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE)) return null
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** Decoded pixels, or null for a PNG this module does not handle. */
export function decodePng(data: Buffer): Png | null {
  if (!pngSize(data)) return null
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const parts: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]!
      channels = CHANNELS[body[9]!] ?? 0
      if (depth !== 8 || !channels || body[12] !== 0) return null
    } else if (type === 'IDAT') parts.push(body)
    else if (type === 'IEND') break
  }
  if (!width || !height || !channels) return null
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) return null
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels]! : 0
      const b = y > 0 ? pixels[out - stride + x]! : 0
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels]! : 0
      let value = line[x]!
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) value += paeth(a, b, c)
      else if (filter !== 0) return null
      pixels[out + x] = value & 0xff
    }
  }
  return { width, height, channels, pixels }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Box-filtered downscale to `width` (height in proportion). Never enlarges. */
export function scalePng(image: Png, width: number): Png {
  if (width >= image.width) return image
  const height = Math.max(1, Math.round(image.height * width / image.width))
  const { channels } = image
  const pixels = Buffer.alloc(width * height * channels)
  const sum = new Float64Array(channels)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * image.height / height)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * image.width / width)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / width))
      sum.fill(0)
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * image.width + x0) * channels
        for (let sx = x0; sx < x1; sx++) {
          for (let k = 0; k < channels; k++) sum[k]! += image.pixels[at + k]!
          at += channels
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      const out = (y * width + x) * channels
      for (let k = 0; k < channels; k++) pixels[out + k] = Math.round(sum[k]! / count)
    }
  }
  return { width, height, channels, pixels }
}

const COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 }

export function encodePng(image: Png): Buffer {
  const stride = image.width * image.channels
  const raw = Buffer.alloc(image.height * (stride + 1))
  for (let y = 0; y < image.height; y++) image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = COLOR_TYPE[image.channels]!
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

let table: Uint32Array | null = null

function crc32(data: Buffer): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** The PNG at most `maxWidth` wide: scaled when this module can read it, else as it was. */
export function shrinkPng(data: Buffer, maxWidth: number): { data: Buffer; width: number; height: number; scaled: boolean } {
  const size = pngSize(data)
  if (!size) return { data, width: 0, height: 0, scaled: false }
  if (size.width <= maxWidth) return { data, ...size, scaled: false }
  const image = decodePng(data)
  if (!image) return { data, ...size, scaled: false }
  const small = scalePng(image, maxWidth)
  return { data: encodePng(small), width: small.width, height: small.height, scaled: true }
}
