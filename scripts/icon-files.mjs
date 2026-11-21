// Container formats for the app icon, written from rasters made by render-icons.mjs.
// Kept dependency-free so the icon pipeline needs nothing beyond Electron.

/** Windows .ico with PNG-compressed images (Vista and later). `images`: [{ size, png }]. */
export function icoFile(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    if (size < 1 || size > 256) throw new Error(`ICO images are 1–256 px, not ${size}`);
    const entry = 6 + 16 * index;
    header[entry] = size === 256 ? 0 : size; // 0 means 256
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

/** macOS .icns from [type, data] entries, e.g. ['ic10', png1024]. */
export function icnsFile(entries) {
  const chunks = entries.map(([type, data]) => {
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error(`Invalid ICNS type ${type}`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

// ICNS run-length encoding: a control byte below 0x80 is followed by that many
// plus one literal bytes; 0x80 and above repeats the next byte (control - 125) times.
function packBits(plane) {
  const out = [];
  let index = 0;
  while (index < plane.length) {
    let run = 1;
    while (index + run < plane.length && run < 130 && plane[index + run] === plane[index]) run++;
    if (run >= 3) {
      out.push(run + 125, plane[index]);
      index += run;
      continue;
    }
    // Literal stretch up to 128 bytes, ending before the next run of three.
    const start = index;
    while (index < plane.length && index - start < 128) {
      if (index + 2 < plane.length && plane[index] === plane[index + 1] && plane[index] === plane[index + 2]) break;
      index++;
    }
    out.push(index - start - 1, ...plane.subarray(start, index));
  }
  return out;
}

/**
 * The 'ARGB' payload iconutil writes for the 16 and 32 px slots (ic04, ic05):
 * straight (not premultiplied) alpha, red, green and blue planes, each run-length encoded.
 * `rgba` is width × height × 4 bytes in canvas order.
 */
export function argbData(rgba, width, height) {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) throw new Error('RGBA buffer does not match the image size');
  const planes = [3, 0, 1, 2].map(channel => {
    const plane = new Uint8Array(pixels);
    for (let pixel = 0; pixel < pixels; pixel++) plane[pixel] = rgba[pixel * 4 + channel];
    return packBits(plane);
  });
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...planes.map(plane => Buffer.from(plane))]);
}
