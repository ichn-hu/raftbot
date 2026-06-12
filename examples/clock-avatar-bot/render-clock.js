#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const size = 512;
const cx = size / 2;
const cy = size / 2;
const digitSegments = {
  0: "abcedf",
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgecd",
  7: "abc",
  8: "abcdefg",
  9: "abfgcd"
};

let pixels = null;

export function renderClockPng(now = new Date(), options = {}) {
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid date: ${now}`);
  }
  const clock = getClockParts(now, options.timeZone);
  pixels = new Uint8ClampedArray(size * size * 4);
  drawBackground();
  fillCircle(cx + 10, cy + 14, 218, [0, 0, 0, 38]);
  fillCircle(cx, cy, 220, [244, 240, 230, 255]);
  fillCircle(cx, cy, 204, [23, 31, 42, 255]);
  fillCircle(cx, cy, 184, [31, 44, 57, 255]);
  drawTicks();
  drawHands(clock);
  drawHub();
  drawDigitalTime(clock);
  return encodePng(size, size, pixels);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2] ?? "clock-avatar.png";
  const now = process.argv[3] ? new Date(process.argv[3]) : new Date();
  const timeZone = process.argv[4];
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, renderClockPng(now, { timeZone }));
  console.log(outputPath);
}

export function getClockParts(date, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hours: Number(values.hour),
    minutes: Number(values.minute),
    seconds: Number(values.second)
  };
}

function drawBackground() {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / size;
      const dy = (y - cy) / size;
      const v = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.9);
      setPixel(x, y, [
        Math.round(15 + v * 34),
        Math.round(22 + v * 34),
        Math.round(31 + v * 38),
        255
      ]);
    }
  }
}

function drawTicks() {
  for (let i = 0; i < 60; i += 1) {
    const major = i % 5 === 0;
    const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const outer = 178;
    const inner = major ? 150 : 164;
    const width = major ? 6 : 2;
    const color = major ? [236, 231, 218, 255] : [123, 142, 153, 210];
    drawLine(
      cx + Math.cos(angle) * inner,
      cy + Math.sin(angle) * inner,
      cx + Math.cos(angle) * outer,
      cy + Math.sin(angle) * outer,
      width,
      color
    );
  }
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    fillCircle(cx + Math.cos(angle) * 126, cy + Math.sin(angle) * 126, 4, [55, 184, 166, 255]);
  }
}

function drawHands(clock) {
  const hours = clock.hours % 12;
  const minutes = clock.minutes;
  const seconds = clock.seconds;
  const hourAngle = ((hours + minutes / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  const minuteAngle = ((minutes + seconds / 60) / 60) * Math.PI * 2 - Math.PI / 2;
  const secondAngle = (seconds / 60) * Math.PI * 2 - Math.PI / 2;

  drawLine(cx, cy, cx + Math.cos(hourAngle) * 88, cy + Math.sin(hourAngle) * 88, 16, [238, 229, 208, 255]);
  drawLine(cx, cy, cx + Math.cos(minuteAngle) * 136, cy + Math.sin(minuteAngle) * 136, 10, [62, 211, 190, 255]);
  drawLine(cx - Math.cos(secondAngle) * 24, cy - Math.sin(secondAngle) * 24, cx + Math.cos(secondAngle) * 154, cy + Math.sin(secondAngle) * 154, 3, [239, 95, 85, 255]);
}

function drawHub() {
  fillCircle(cx, cy, 20, [244, 240, 230, 255]);
  fillCircle(cx, cy, 10, [239, 95, 85, 255]);
}

function drawDigitalTime(clock) {
  const text = `${String(clock.hours).padStart(2, "0")}:${String(clock.minutes).padStart(2, "0")}`;
  const digitW = 34;
  const digitH = 58;
  const gap = 8;
  const colonW = 12;
  const totalW = digitW * 4 + gap * 4 + colonW;
  let x = Math.round(cx - totalW / 2);
  const y = 354;
  drawRoundRect(x - 18, y - 17, totalW + 36, digitH + 34, 20, [13, 18, 25, 190]);
  for (const ch of text) {
    if (ch === ":") {
      fillCircle(x + colonW / 2, y + 20, 4, [236, 231, 218, 255]);
      fillCircle(x + colonW / 2, y + 39, 4, [236, 231, 218, 255]);
      x += colonW + gap;
    } else {
      drawSevenSegmentDigit(Number(ch), x, y, digitW, digitH, [236, 231, 218, 255]);
      x += digitW + gap;
    }
  }
}

function drawSevenSegmentDigit(n, x, y, w, h, color) {
  const active = new Set(digitSegments[n]);
  const t = 7;
  const pad = 3;
  const mid = y + h / 2;
  const segments = {
    a: [x + pad, y, w - pad * 2, t],
    b: [x + w - t, y + pad, t, h / 2 - pad],
    c: [x + w - t, mid, t, h / 2 - pad],
    d: [x + pad, y + h - t, w - pad * 2, t],
    e: [x, mid, t, h / 2 - pad],
    f: [x, y + pad, t, h / 2 - pad],
    g: [x + pad, mid - t / 2, w - pad * 2, t]
  };
  for (const [name, rect] of Object.entries(segments)) {
    const alpha = active.has(name) ? 255 : 34;
    drawRoundRect(...rect, 4, [...color.slice(0, 3), alpha]);
  }
}

function drawRoundRect(x, y, w, h, r, color) {
  const left = Math.floor(x);
  const right = Math.ceil(x + w);
  const top = Math.floor(y);
  const bottom = Math.ceil(y + h);
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      const qx = Math.max(x + r, Math.min(px, x + w - r));
      const qy = Math.max(y + r, Math.min(py, y + h - r));
      const dx = px - qx;
      const dy = py - qy;
      if (dx * dx + dy * dy <= r * r) blendPixel(px, py, color);
    }
  }
}

function drawLine(x1, y1, x2, y2, width, color) {
  const minX = Math.floor(Math.min(x1, x2) - width);
  const maxX = Math.ceil(Math.max(x1, x2) + width);
  const minY = Math.floor(Math.min(y1, y2) - width);
  const maxY = Math.ceil(Math.max(y1, y2) + width);
  const lenSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  const radius = width / 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lenSq));
      const px = x1 + t * (x2 - x1);
      const py = y1 + t * (y2 - y1);
      const d = Math.hypot(x - px, y - py);
      if (d <= radius) blendPixel(x, y, color);
    }
  }
}

function fillCircle(x, y, radius, color) {
  const minX = Math.floor(x - radius);
  const maxX = Math.ceil(x + radius);
  const minY = Math.floor(y - radius);
  const maxY = Math.ceil(y + radius);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) blendPixel(px, py, color);
    }
  }
}

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  pixels[idx] = color[0];
  pixels[idx + 1] = color[1];
  pixels[idx + 2] = color[2];
  pixels[idx + 3] = color[3];
}

function blendPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  const a = color[3] / 255;
  const inv = 1 - a;
  pixels[idx] = Math.round(color[0] * a + pixels[idx] * inv);
  pixels[idx + 1] = Math.round(color[1] * a + pixels[idx + 1] * inv);
  pixels[idx + 2] = Math.round(color[2] * a + pixels[idx + 2] * inv);
  pixels[idx + 3] = 255;
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(scanlines, rowStart + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])) >>> 0)]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
