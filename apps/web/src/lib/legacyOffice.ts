/**
 * The two office formats that predate the zipped-XML ones: `.doc` (Word 97-2003)
 * and `.ppt` (PowerPoint 97-2003). Both are OLE containers of binary streams, and
 * no browser can lay them out — Word's layout lives in the printer driver's
 * metrics, PowerPoint's in a binary scene graph. What *is* readable is the text
 * they carry, and that is what a reader gets here: the document's words, in its
 * own order, plainly. Anything more would be a promise these formats cannot keep.
 *
 * Both readers work on the bytes themselves, so the app carries no Office: the
 * OLE reader is a chunk of its own, fetched the first time one of the two
 * formats is opened.
 */
import type { CFB$Container } from "cfb";

async function openContainer(source: ArrayBuffer): Promise<CFB$Container> {
  const { read } = await import("cfb");
  return read(new Uint8Array(source), { type: "array" }) as unknown as CFB$Container;
}

const ENC = (label: string) => new TextDecoder(label);

/** `WordDocument`'s FibBase.lid for a Russian document: single-byte runs are cp1251. */
const LID_RUSSIAN = 0x0419;

type DocBytes = {
  dv: DataView;
  bytes: Uint8Array;
};

function view(bytes: Uint8Array): DocBytes {
  return { dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes };
}

/** One named stream of the container, as bytes. */
function stream(cfb: CFB$Container, name: string): DocBytes | null {
  const entry = cfb.FileIndex.find(
    (file, index) => file && cfb.FullPaths[index]?.includes(`/${name}`),
  );
  if (!entry?.content) return null;
  return view(new Uint8Array(entry.content as Uint8Array));
}

function u16(v: DataView, at: number) {
  return at + 2 <= v.byteLength ? v.getUint16(at, true) : 0;
}

function u32(v: DataView, at: number) {
  return at + 4 <= v.byteLength ? v.getUint32(at, true) : 0;
}

/** A Word 97-2003 piece table: character positions and the runs they point at. */
function docPieces(text: DocBytes, table: DocBytes) {
  const fcClx = u32(text.dv, 0x01a2);
  const lcbClx = u32(text.dv, 0x01a6);
  if (!lcbClx || fcClx + lcbClx > table.bytes.length) return null;
  let pos = fcClx;
  const end = fcClx + lcbClx;
  // Prc blocks (0x01) carry formatting; the piece table (0x02) is what we want.
  while (pos < end) {
    const kind = table.bytes[pos]!;
    if (kind === 0x01) {
      pos += 3 + u16(table.dv, pos + 1);
      continue;
    }
    if (kind !== 0x02) return null;
    const lcb = u32(table.dv, pos + 1);
    const start = pos + 5;
    if (start + lcb > end || (lcb - 4) % 12 !== 0) return null;
    const count = (lcb - 4) / 12;
    const cps: number[] = [];
    for (let i = 0; i <= count; i += 1) cps.push(u32(table.dv, start + i * 4));
    const pcdBase = start + (count + 1) * 4;
    return { count, cps, pcdBase };
  }
  return null;
}

/** The text of a Word 97-2003 document, in its own order. */
export async function docText(source: ArrayBuffer): Promise<string> {
  const cfb = await openContainer(source);
  const main = stream(cfb, "WordDocument");
  if (!main) return "";
  const lid = u16(main.dv, 0x0006);
  const flags = u16(main.dv, 0x000a);
  // Bit 9 of FibBase.grf says which table stream holds the piece table.
  const table = stream(cfb, flags & 0x0200 ? "1Table" : "0Table");
  if (!table) return "";
  const pieces = docPieces(main, table);
  // A fast-saved or a Word 6/95 file may hold no readable piece table: the words
  // are still in the stream, in runs, and plain text is what this reader
  // promises. The structured read is always tried first.
  if (!pieces) return cleanWordText(scanRuns(main.bytes, lid));
  const single = ENC(lid === LID_RUSSIAN ? "windows-1251" : "windows-1252");
  const wide = ENC("utf-16le");
  let out = "";
  for (let i = 0; i < pieces.count; i += 1) {
    const fc = u32(table.dv, pieces.pcdBase + i * 8 + 2);
    const cch = pieces.cps[i + 1]! - pieces.cps[i]!;
    if (cch <= 0) continue;
    // A compressed run is one byte per character, and its offset is halved.
    const compressed = (fc & 0x40000000) !== 0;
    const at = fc & 0x3fffffff;
    if (compressed) {
      const from = at >>> 1;
      out += single.decode(main.bytes.subarray(from, from + cch));
    } else {
      out += wide.decode(main.bytes.subarray(at, at + cch * 2));
    }
  }
  return cleanWordText(out);
}

/**
 * The last resort of a reader: printable runs out of a stream that no piece
 * table describes. It cannot be more than text, and it says nothing when there is
 * none — a wrong word is worse than a short one.
 */
function scanRuns(bytes: Uint8Array, lid: number): string {
  const single = ENC(lid === LID_RUSSIAN ? "windows-1251" : "windows-1252");
  const parts: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length < 8) {
      run = [];
      return;
    }
    const text = single.decode(new Uint8Array(run));
    const words = text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
    // A run of letters and punctuation, not a slice of a spreadsheet or a font.
    if (words.length >= 2) parts.push(text);
    run = [];
  };
  for (const byte of bytes) {
    const printable =
      byte === 0x0d || byte === 0x0a || byte === 0x09 || (byte >= 0x20 && byte !== 0x7f);
    if (printable) run.push(byte);
    else flush();
  }
  flush();
  return parts.join("\n");
}

/** Word stores structure as control characters; a reader wants the structure. */
function cleanWordText(raw: string): string {
  let out = "";
  let inField = false;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 0x13) {
      inField = true;
      continue;
    }
    if (code === 0x14) {
      // The field's own result follows its instruction.
      inField = false;
      continue;
    }
    if (code === 0x15) continue;
    if (inField) continue;
    if (code === 0x0d || code === 0x0b || code === 0x0c) {
      out += "\n";
      continue;
    }
    if (code === 0x07) {
      out += "\t";
      continue;
    }
    if (code === 0x1e) {
      out += "-";
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue;
    out += ch;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** PowerPoint record types whose payload is a slide's text. */
const PPT_TEXT_CHARS = 0x0fa0;
const PPT_TEXT_BYTES = 0x0fa8;

/** The text of a PowerPoint 97-2003 deck, slide by slide as the stream holds it. */
export async function pptText(source: ArrayBuffer): Promise<string> {
  const cfb = await openContainer(source);
  const deck = stream(cfb, "PowerPoint Document");
  if (!deck) return "";
  const wide = ENC("utf-16le");
  const single = ENC("windows-1252");
  const runs: string[] = [];

  // Records nest by their version nibble: 0xF is a container of records, any
  // other version a leaf. Text leaves are the only ones kept.
  const walk = (from: number, to: number) => {
    let pos = from;
    while (pos + 8 <= to) {
      const verInst = u16(deck.dv, pos);
      const type = u16(deck.dv, pos + 2);
      const len = u32(deck.dv, pos + 4);
      const body = pos + 8;
      if (body + len > to) return;
      if ((verInst & 0x000f) === 0x000f) {
        walk(body, body + len);
      } else if (type === PPT_TEXT_CHARS) {
        runs.push(wide.decode(deck.bytes.subarray(body, body + len)));
      } else if (type === PPT_TEXT_BYTES) {
        runs.push(single.decode(deck.bytes.subarray(body, body + len)));
      }
      pos = body + len;
    }
  };
  walk(0, deck.bytes.length);
  return runs
    .map((run) => run.replace(/[\r\v\f]/g, "\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
