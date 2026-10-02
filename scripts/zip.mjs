/**
 * Read one file out of a ZIP archive, with a hard output bound and a checksum.
 *
 * Actions serves an artifact as a ZIP, so verifying a binding that arrives as an
 * artifact means opening a ZIP. Node has no built-in ZIP reader, and shelling out
 * to `unzip` would mean trusting a tool that may not be installed on a runner and
 * whose exit status is not the thing being verified.
 *
 * This reads exactly what it needs: the end-of-central-directory record, the
 * central directory, and the one local header for the file asked for. It never
 * extracts anything to disk and never executes content.
 *
 * ## Why the bound and the checksum are load-bearing
 *
 * The bytes here decide whether a merge is authorised, so two things matter that
 * would not matter for a convenience reader:
 *
 * - **The output cap is applied to the decompressor, not checked afterwards.**
 *   Deflate is high-ratio by design: a few kilobytes expand to megabytes, and a
 *   handful of kilobytes can expand to gigabytes. A reader that inflates first and
 *   inspects the length afterwards has already paid the allocation. The cap is
 *   passed to `inflateRawSync` so the buffer is never grown past it.
 * - **The declared and computed sizes must agree, and the CRC-32 must match.** A
 *   truncated or altered archive can otherwise produce bytes that still parse as a
 *   well-formed binding, which is the failure mode that matters: not a crash, but
 *   a security claim accepted on the strength of corrupt input.
 *
 * The archive is treated as hostile regardless. The artifact server is the expected
 * source, but a forged archive reaches this function whenever a check can be made
 * to return one, so nothing here relies on the input being well behaved.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** General purpose bit flags that change how an entry must be read. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

/** A fixed ceiling, so a malformed length field cannot allocate unbounded. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

// --- CRC-32 (IEEE 802.3, reflected) -----------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 of a buffer, matching what a ZIP central directory records. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  // The EOCD is at the end, after an optional variable-length comment, so it is
  // searched backwards over at most the maximum comment length plus its header.
  const start = Math.max(0, buffer.length - (MAX_COMMENT + 22));
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * The bytes of `name` inside a ZIP archive.
 *
 * Returns null when the archive is unreadable or does not contain `name`. Throws
 * when the entry is present but cannot be trusted — over the size bound, with an
 * unsupported compression method, encrypted, with a CRC or size that does not
 * match, or corrupt. Those are different outcomes: an absent entry is "there is
 * no evidence", and a present-but-untrustworthy entry is "the evidence is not
 * sound", and the caller must not conflate them.
 */
export function readZipEntry(buffer, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (entryName !== name) continue;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error(`ZIP entry ${name} is encrypted, which is not supported`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP entry ${name} declares ${uncompressedSize} uncompressed bytes, over the ${MAX_ENTRY_BYTES} byte bound`);
    }
    if (compressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP entry ${name} declares ${compressedSize} compressed bytes, over the ${MAX_ENTRY_BYTES} byte bound`);
    }
    if (localOffset + 30 > buffer.length) {
      throw new Error(`ZIP entry ${name} has a local header outside the archive`);
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP entry ${name} has no local header at its declared offset`);
    }
    // The local header repeats the name and extra lengths, and the extra field may
    // differ from the central one, so the data offset is computed from the local
    // header rather than reused. Sizes and CRC are taken from the central
    // directory, which is authoritative even when bit 3 records a data descriptor
    // and leaves the local copies zeroed.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP entry ${name} is truncated`);
    }
    const raw = buffer.subarray(dataStart, dataEnd);

    let bytes;
    if (method === METHOD_STORED) {
      if (compressedSize !== uncompressedSize) {
        throw new Error(`ZIP entry ${name} is stored but its sizes disagree`);
      }
      bytes = Buffer.from(raw);
    } else {
      // The cap is applied to the decompressor itself. Checking the length
      // afterwards would be too late: the allocation has already happened.
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        const code = error instanceof Error ? error.code : undefined;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`ZIP entry ${name} inflates past the ${MAX_ENTRY_BYTES} byte bound`);
        }
        throw new Error(`ZIP entry ${name} could not be decompressed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (bytes.length !== uncompressedSize) {
      throw new Error(`ZIP entry ${name} inflated to ${bytes.length} bytes but declares ${uncompressedSize}`);
    }
    const actual = crc32(bytes);
    if (actual !== expectedCrc) {
      throw new Error(
        `ZIP entry ${name} fails its checksum (${actual.toString(16)} against ${expectedCrc.toString(16)}); the archive is corrupt or altered`,
      );
    }
    return bytes;
  }
  return null;
}

export const ZIP_MAX_ENTRY_BYTES = MAX_ENTRY_BYTES;
/** Exposed so a caller can recognise a data-descriptor archive without guessing. */
export const ZIP_USES_DATA_DESCRIPTOR = FLAG_DATA_DESCRIPTOR;
