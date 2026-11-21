import { posix, extname } from 'node:path';
import { SaxesParser } from 'saxes';
import { fromBufferPromise, type Entry } from 'yauzl';
import { t } from '../shared/i18n';

const xmlLimit = 8 * 1024 * 1024, totalXmlLimit = 24 * 1024 * 1024, textLimit = 256 * 1024;
type Attrs = Record<string, string>;
interface XmlEvents {
  open?(name: string, attributes: Attrs): void;
  text?(content: string): void;
  close?(name: string): void;
}

// Only interpret document text and relationships inside the archive. No XML
// entities, macros, embedded objects, external references or native Office app.
function parseXml(bytes: Buffer, events: XmlEvents): void {
  const parser = new SaxesParser();
  const local = (name: string) => name.slice(name.indexOf(':') + 1);
  parser.on('doctype', () => { throw new Error(t('artifacts.xmlDoctype')); });
  parser.on('opentag', tag => events.open?.(local(tag.name), tag.attributes));
  parser.on('closetag', tag => events.close?.(local(tag.name)));
  parser.on('text', value => events.text?.(value));
  parser.on('cdata', value => events.text?.(value));
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  parser.write(new TextDecoder(encoding, { fatal: true }).decode(bytes)).close();
}

export async function extractOfficeText(name: string, bytes: Buffer): Promise<{ text: string; truncated: boolean }> {
  const zip = await fromBufferPromise(bytes, { autoClose: false, strictFileNames: true });
  const files = new Map<string, Entry>();
  let budget = totalXmlLimit, length = 0, truncated = false;
  const parts: string[] = [];
  function append(value: string) {
    if (!value) return;
    const take = Math.min(textLimit - length, value.length);
    if (take) parts.push(take === value.length ? value : value.slice(0, take));
    length += take;
    if (take < value.length) truncated = true;
  }
  async function xml(file: string, events: XmlEvents) {
    const entry = files.get(file);
    if (!entry || entry.isEncrypted()) throw new Error(t('artifacts.documentBodyMissing'));
    if (entry.uncompressedSize > xmlLimit || entry.uncompressedSize > budget) throw new Error(t('artifacts.documentBodyTooLarge'));
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of stream) {
      size += value.length;
      if (size > entry.uncompressedSize || size > budget || size > xmlLimit) throw new Error(t('artifacts.documentBodyTooLarge'));
      chunks.push(value);
    }
    budget -= size;
    parseXml(Buffer.concat(chunks, size), events);
  }
  async function relationships(file: string) {
    const targets = new Map<string,string>();
    const relFile = posix.join(posix.dirname(file), '_rels', posix.basename(file) + '.rels');
    await xml(relFile, { open(tag, a) {
      if (tag !== 'Relationship' || !a.Id || !a.Target || a.TargetMode === 'External' || /[\\\0?#]|^[a-z]+:/i.test(a.Target)) return;
      const target = a.Target.startsWith('/') ? a.Target.slice(1) : posix.join(posix.dirname(file), a.Target);
      if (files.has(target)) targets.set(a.Id, target);
    } });
    return targets;
  }
  async function paragraphText(file: string) {
    let text = false;
    await xml(file, {
      open(tag) { if (tag === 't') text = true; if (tag === 'tab') append('\t'); if (tag === 'br' || tag === 'cr') append('\n'); },
      text(value) { if (text) append(value); },
      close(tag) { if (tag === 't') text = false; if (tag === 'p' || tag === 'tr') append('\n'); },
    });
  }
  try {
    if (zip.entryCount > 4096) throw new Error(t('artifacts.tooManyEntries'));
    for await (const entry of zip.eachEntry()) {
      if (files.has(entry.fileName)) throw new Error(t('artifacts.duplicateEntries'));
      files.set(entry.fileName, entry);
    }
    const ext = extname(name).toLowerCase();
    if (ext === '.docx') {
      await paragraphText('word/document.xml');
    } else if (ext === '.pptx') {
      const main = 'ppt/presentation.xml', rels = await relationships(main), slides: string[] = [];
      await xml(main, {open(tag, a) { const target = rels.get(a['r:id']); if (tag === 'sldId' && target) slides.push(target); }});
      for (const [i, slide] of slides.entries()) {
        if (truncated) break;
        append(`${t('artifacts.slide', { n: i + 1 })}\n`); await paragraphText(slide); append('\n');
      }
    } else if (ext === '.xlsx') {
      const main = 'xl/workbook.xml', rels = await relationships(main), sheets: {label:string; file:string}[] = [], strings: string[] = [];
      await xml(main, {open(tag, a) { const file = rels.get(a['r:id']); if (tag === 'sheet' && file) sheets.push({ label: a.name, file }); }});
      if (files.has('xl/sharedStrings.xml')) {
        let value = '', reading = false;
        await xml('xl/sharedStrings.xml', {
          open(tag) { if (tag === 'si') value = ''; if (tag === 't') reading = true; },
          text(text) { if (reading) value += text; },
          close(tag) { if (tag === 't') reading = false; if (tag === 'si') strings.push(value); },
        });
      }
      for (const sheet of sheets) {
        if (truncated) break;
        append(sheet.label + '\n');
        let ref = '', type = '', value = '', formula = '', read = '';
        await xml(sheet.file, {
          open(tag, a) {
            if (tag === 'c') { ref = a.r || ''; type = a.t; value = formula = ''; }
            if (['v', 't', 'f'].includes(tag)) read = tag;
          },
          text(text) { if (read === 'f') formula += text; else if (read) value += text; },
          close(tag) {
            if (tag === read) read = '';
            if (tag === 'c') {
              if (type === 's' && /^\d+$/.test(value)) value = strings[Number(value)] ?? '';
              else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
              if (value || formula) append(`${ref}  ${value || '=' + formula}\t`);
            }
            if (tag === 'row') append('\n');
          },
        });
        append('\n');
      }
    } else if (['.odt', '.ods', '.odp'].includes(ext)) {
      let body = false, paragraph = 0;
      await xml('content.xml', {
        open(tag, a) {
          if (tag === 'body') body = true;
          if (!body) return;
          if (tag === 'p' || tag === 'h') paragraph++;
          if (tag === 'tab') append('\t');
          if (tag === 'line-break') append('\n');
          if (tag === 's') append(' '.repeat(Math.max(1, Math.min(256, Number.parseInt(a['text:c'] || '1', 10) || 1))));
        },
        text(text) { if (body && paragraph) append(text); },
        close(tag) { if (body && (tag === 'p' || tag === 'h')) { paragraph--; append('\n'); } if (tag === 'body') body = false; },
      });
    } else throw new Error(t('artifacts.unsupportedDocument'));
    return { text: parts.join('').trimEnd(), truncated };
  } finally { zip.close(); }
}
