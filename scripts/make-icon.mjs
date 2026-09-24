// 生成插件图标 icon.png：160x160 圆角渐变背景 + 白色 ¥ 符号（纯 Node 实现 PNG 编码，无需依赖）
import {deflateSync} from "node:zlib";
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";

const W = 160, H = 160, R = 40;
const img = new Uint8Array(W * H * 4);

// 圆角矩形有符号距离（像素）
function roundedRectSDF(px, py) {
    const cx = W / 2, cy = H / 2, hw = W / 2 - 4, hh = H / 2 - 4;
    const qx = Math.abs(px - cx) - (hw - R), qy = Math.abs(py - cy) - (hh - R);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R;
}

// 线段有符号距离（px 为半粗细）
const STROKE = 4;
function segmentSDF(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1, vy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)) - STROKE;
}

// ¥ 字形：两条斜线、竖笔、两道横杠
const GLYPH = [
    [52, 40, 80, 76], [108, 40, 80, 76],   // 斜线
    [80, 76, 80, 120],                      // 竖笔
    [56, 84, 104, 84], [56, 102, 104, 102], // 横杠
];
function glyphSDF(px, py) {
    let d = Infinity;
    for (const [x1, y1, x2, y2] of GLYPH) {
        d = Math.min(d, segmentSDF(px, py, x1, y1, x2, y2));
    }
    return d;
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const coverage = d => clamp01(0.5 - d);

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const bgA = coverage(roundedRectSDF(x + 0.5, y + 0.5));
        if (bgA <= 0) continue;
        // 对角渐变：蓝 → 青
        const t = (x + y) / (W + H);
        let r = 79 + (46 - 79) * t, g = 124 + (189 - 124) * t, b = 255 + (168 - 255) * t;
        const fgA = coverage(glyphSDF(x + 0.5, y + 0.5));
        r = r + (255 - r) * fgA;
        g = g + (255 - g) * fgA;
        b = b + (255 - b) * fgA;
        img[i] = Math.round(r);
        img[i + 1] = Math.round(g);
        img[i + 2] = Math.round(b);
        img[i + 3] = Math.round(bgA * 255);
    }
}

// ---- PNG 编码 ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c;
});
function crc32(buf) {
    let c = -1;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    Buffer.from(img.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
}
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "icon.png");
writeFileSync(out, png);
console.log("icon created:", out, png.length, "bytes");
