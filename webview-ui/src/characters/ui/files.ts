/**
 * Files the Characters view saves and loads: a character's sheet (PNG), one piece's sheet
 * (PNG), the whole cast (every sheet and config) in a zip, and profile configs (JSON).
 */

import { isBrowserRuntime } from '../../runtime.js';
import { transport } from '../../transport/index.js';
import { sheetImage } from './pixelCanvas.js';

/**
 * Offer a generated file. The browser downloads it; VS Code's webview can't, so the host
 * shows its save dialog.
 */
export async function saveFile(filename: string, data: Blob): Promise<void> {
  if (isBrowserRuntime) {
    const url = URL.createObjectURL(data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0); // after the download has started
    return;
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  transport.send({ type: 'exportFile', filename, dataBase64: btoa(binary) });
}

/** Opens the file chooser; `onPick` gets what was chosen. */
export function pickFiles(accept: string, multiple: boolean, onPick: (files: File[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.hidden = true;
  // in the page while the chooser is open (iOS Safari drops a detached input's change)
  document.body.append(input);
  input.onchange = () => {
    input.remove();
    onPick([...(input.files ?? [])]);
  };
  input.oncancel = () => input.remove();
  input.click();
}

/** A sheet as base64 PNG (no data: prefix), encoded synchronously. */
export function sheetPngBase64(sheet: Uint8ClampedArray): string {
  return sheetImage(sheet)
    .toDataURL('image/png')
    .replace(/^data:image\/png;base64,/, '');
}

export function sheetPng(sheet: Uint8ClampedArray): Promise<Blob> {
  return new Promise((resolve, reject) =>
    sheetImage(sheet).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))),
      'image/png',
    ),
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip: the PNGs inside are compressed already. */
export function zipFiles(files: { name: string; data: Uint8Array }[]): Blob {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(local.buffer, name, file.data as Uint8Array<ArrayBuffer>);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, name);
    centralSize += 46 + name.length;
    offset += 30 + name.length + size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}
