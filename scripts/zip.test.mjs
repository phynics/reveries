import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";

import { crc32, readZipEntry, ZIP_MAX_ENTRY_BYTES } from "./zip.mjs";

/**
 * Build a ZIP archive in memory, so a test can declare hostile sizes and
 * corrupt exactly the bytes it means to.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8, declaredUncompressed, declaredCrc, payloadOverride } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const payload = payloadOverride ?? (method === 0 ? data : deflateRawSync(data));
    const crc = declaredCrc ?? crc32(data);
    const uncompressed = declaredUncompressed ?? data.length;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const BODY = Buffer.from(JSON.stringify({ v: 1, pull_request: 26, head_sha: "a".repeat(40) }));

test("a well-formed deflate entry is read and matches its checksum", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY }]);
  assert.deepEqual(readZipEntry(zip, "binding.json"), BODY);
});

test("a well-formed stored entry is read", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY, method: 0 }]);
  assert.deepEqual(readZipEntry(zip, "binding.json"), BODY);
});

// --- The decompression bomb -------------------------------------------------

test("a high-ratio entry is refused without inflating past the bound", () => {
  // 32 MiB of zeros compresses to a few kilobytes. Without a cap passed to the
  // decompressor, this allocation happens before any size check: the reader would
  // have paid 32 MiB to learn the entry was unacceptable.
  const bomb = Buffer.alloc(32 * 1024 * 1024);
  const zip = buildZip([{ name: "binding.json", data: bomb }]);
  assert.ok(
    zip.length < 128 * 1024,
    `the bomb archive is ${zip.length} bytes, so a multi-megabyte allocation would come from a tiny input`,
  );
  assert.throws(
    () => readZipEntry(zip, "binding.json"),
    (error) => {
      assert.match(error.message, /inflates past the|declares .* uncompressed bytes, over the/);
      return true;
    },
  );
});

test("a declared uncompressed size over the bound is refused before decompressing", () => {
  // The central directory is attacker-controlled, so the cheap check comes first
  // and the decompressor is never reached.
  const small = Buffer.alloc(16);
  const zip = buildZip([{ name: "binding.json", data: small, declaredUncompressed: ZIP_MAX_ENTRY_BYTES + 1 }]);
  assert.throws(() => readZipEntry(zip, "binding.json"), /over the .* byte bound/);
});

test("a stored entry whose sizes disagree is refused", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY, method: 0, declaredUncompressed: BODY.length + 1 }]);
  assert.throws(() => readZipEntry(zip, "binding.json"), /sizes disagree/);
});

// --- Corruption -------------------------------------------------------------

test("an entry that fails its checksum is refused", () => {
  // Corrupt but still parseable bytes are the dangerous case: a reader that only
  // checks the size would accept a security claim built from an altered archive.
  const zip = buildZip([{ name: "binding.json", data: BODY }]);
  // Find the deflate payload and flip a bit in it.
  const nameOffset = 30 + Buffer.byteLength("binding.json");
  zip[nameOffset + 4] ^= 0xff;
  assert.throws(
    () => readZipEntry(zip, "binding.json"),
    /fails its checksum|could not be decompressed/,
  );
});

test("a wrong declared checksum is refused", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY, declaredCrc: 0xdeadbeef }]);
  assert.throws(() => readZipEntry(zip, "binding.json"), /fails its checksum/);
});

test("a declared size that disagrees with the real output is refused", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY, declaredUncompressed: BODY.length + 4 }]);
  assert.throws(() => readZipEntry(zip, "binding.json"), /inflated to .* but declares/);
});

test("an encrypted entry is refused rather than mis-read", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY }]);
  // Set general purpose bit 0 (encrypted) in both headers.
  zip.writeUInt16LE(zip.readUInt16LE(6) | 0x0001, 6);
  const centralStart = zip.length - 22 - (46 + Buffer.byteLength("binding.json"));
  zip.writeUInt16LE(zip.readUInt16LE(centralStart + 8) | 0x0001, centralStart + 8);
  assert.throws(() => readZipEntry(zip, "binding.json"), /encrypted/);
});

test("an archive with no end-of-central-directory record yields nothing", () => {
  // Cutting off the trailing record leaves an archive that cannot be indexed at
  // all. That is "no evidence", not a crash, and the caller refuses either way.
  const zip = buildZip([{ name: "binding.json", data: BODY }]);
  assert.equal(readZipEntry(zip.subarray(0, zip.length - 22), "binding.json"), null);
});

test("a payload cut short of its declared output is refused", () => {
  // The deflate stream is truncated while the entry still declares its full
  // uncompressed size, which is what a cut-off download looks like. It must be an
  // error, never a short read that parses as a smaller binding.
  const truncated = deflateRawSync(BODY).subarray(0, 5);
  const zip = buildZip([{ name: "binding.json", data: BODY, payloadOverride: truncated }]);
  assert.throws(
    () => readZipEntry(zip, "binding.json"),
    (error) => {
      assert.match(error.message, /could not be decompressed|inflated to .* but declares|fails its checksum/);
      return true;
    },
  );
});

// --- Absent and unreadable --------------------------------------------------

test("an absent entry is null, which is a different outcome from untrustworthy", () => {
  const zip = buildZip([{ name: "other.json", data: BODY }]);
  assert.equal(readZipEntry(zip, "binding.json"), null);
  assert.equal(readZipEntry(Buffer.from("not a zip at all"), "binding.json"), null);
  assert.equal(readZipEntry(Buffer.alloc(4), "binding.json"), null);
});

test("an unsupported compression method is refused", () => {
  const zip = buildZip([{ name: "binding.json", data: BODY, method: 0 }]);
  // Method 12 (bzip2) is neither stored nor deflate.
  zip.writeUInt16LE(12, 8);
  const centralStart = zip.length - 22 - (46 + Buffer.byteLength("binding.json"));
  zip.writeUInt16LE(12, centralStart + 10);
  assert.throws(() => readZipEntry(zip, "binding.json"), /unsupported compression method 12/);
});

test("the CRC-32 matches the known value for a standard input", () => {
  // The canonical check value, so the implementation is verified against an
  // external reference rather than only against itself.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});
