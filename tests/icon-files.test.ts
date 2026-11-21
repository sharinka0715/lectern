import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { argbData, icnsFile, icoFile } from '../scripts/icon-files.mjs';

const root = new URL('../', import.meta.url);
const png = (width: number, height = width) => {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
};

// Reads ICNS chunks the way macOS does: 4-byte type, 4-byte big-endian length including the header.
function chunks(file: Buffer) {
  assert.equal(file.toString('latin1', 0, 4), 'icns');
  assert.equal(file.readUInt32BE(4), file.length);
  const out: [string, Buffer][] = [];
  for (let at = 8; at < file.length; at += file.readUInt32BE(at + 4)) out.push([file.toString('latin1', at, at + 4), file.subarray(at + 8, at + file.readUInt32BE(at + 4))]);
  return out;
}

function unpackArgb(data: Buffer, pixels: number) {
  assert.equal(data.toString('latin1', 0, 4), 'ARGB');
  const bytes: number[] = [];
  let at = 4;
  while (at < data.length) {
    const control = data[at++];
    if (control < 0x80) for (let i = 0; i <= control; i++) bytes.push(data[at++]);
    else { const value = data[at++]; for (let i = 0; i < control - 125; i++) bytes.push(value); }
  }
  assert.equal(at, data.length);
  assert.equal(bytes.length, pixels * 4);
  return bytes;
}

test('ARGB entries round-trip: alpha, red, green and blue planes, run-length encoded like iconutil', () => {
  const size = 32, rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // Long transparent runs, a noisy band longer than one literal block, and partial alpha.
    const noisy = i >= 300 && i < 600;
    rgba.set([noisy ? (i * 37) % 256 : 10, noisy ? (i * 11) % 256 : 20, 30, i < 300 ? 0 : i % 3 ? 255 : 128], i * 4);
  }
  const planes = unpackArgb(argbData(rgba, size, size), size * size);
  [3, 0, 1, 2].forEach((channel, plane) => {
    for (let i = 0; i < size * size; i++) assert.equal(planes[plane * size * size + i], rgba[i * 4 + channel]);
  });
  assert.ok(argbData(rgba, size, size).length < rgba.length, 'runs are compressed');
  assert.throws(() => argbData(rgba, 16, 16), /does not match/);
});

test('ICNS and ICO containers carry PNG images with correct headers and offsets', () => {
  const icns = icnsFile([['ic07', png(128)], ['ic10', png(1024)]]);
  assert.deepEqual(chunks(icns).map(([type, data]) => [type, data.readUInt32BE(16)]), [['ic07', 128], ['ic10', 1024]]);
  const ico = icoFile([{ size: 16, png: png(16) }, { size: 256, png: png(256) }]);
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 2]);
  const entry = (index: number) => ({ width: ico[6 + 16 * index], bytes: ico.readUInt32LE(14 + 16 * index), offset: ico.readUInt32LE(18 + 16 * index) });
  assert.deepEqual(entry(0), { width: 16, bytes: 24, offset: 38 });
  assert.deepEqual(entry(1), { width: 0, bytes: 24, offset: 62 }, '256 px is written as 0');
  assert.equal(ico.subarray(62).readUInt32BE(16), 256);
  assert.throws(() => icoFile([{ size: 512, png: png(512) }]), /1–256/);
});

test('the committed app icons match the package configuration (rerun scripts/render-icons.mjs after editing the SVG)', () => {
  const config = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).build;
  const icns = readFileSync(new URL(config.mac.icon, root));
  const types = chunks(icns).map(([type, data]) => type + (data.toString('latin1', 0, 4) === 'ARGB' ? ':argb' : ':' + data.readUInt32BE(16)));
  assert.deepEqual(types, ['ic04:argb', 'ic05:argb', 'ic11:32', 'ic12:64', 'ic07:128', 'ic13:256', 'ic08:256', 'ic14:512', 'ic09:512', 'ic10:1024']);
  const ico = readFileSync(new URL(config.win.icon, root));
  assert.deepEqual(Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256), [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(config.win.extraResources[0].from, config.win.icon);
  for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
    const file = new URL(`${config.linux.icon}/${size}x${size}.png`, root);
    assert.equal(readFileSync(file).readUInt32BE(16), size, file.pathname);
  }
  for (const resource of config.extraResources) assert.ok(existsSync(new URL(resource.from, root)), resource.from);
  assert.equal(readFileSync(new URL('build/lectern-mark-small.png', root)).readUInt32BE(16), 64, 'sidebar mark, simplified artwork at 2x');
});
