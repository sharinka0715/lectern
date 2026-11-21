export function icoFile(images: { size: number; png: Buffer }[]): Buffer;
export function icnsFile(entries: [type: string, data: Buffer][]): Buffer;
export function argbData(rgba: Uint8Array, width: number, height: number): Buffer;
