/**
 * Minimal ZIP file builder — no external dependencies.
 *
 * Builds an uncompressed ZIP archive (STORE method) from an array of
 * { name: string, data: Uint8Array } entries. Good enough for .eml
 * text files where compression adds complexity for minimal gain.
 *
 * Compatible with all ZIP readers (macOS Archive Utility, 7-Zip, WinZip, etc.)
 */

export function buildZip(files) {
	const localHeaders = [];
	const centralHeaders = [];
	let offset = 0;

	for (const file of files) {
		const nameBytes = new TextEncoder().encode(file.name);
		const data = file.data;

		// Local file header (30 bytes + name + data)
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const lv = new DataView(local.buffer);

		lv.setUint32(0, 0x04034b50, true);  // Local file header signature
		lv.setUint16(4, 20, true);           // Version needed (2.0)
		lv.setUint16(6, 0, true);            // General purpose flags
		lv.setUint16(8, 0, true);            // Compression: STORE
		lv.setUint16(10, 0, true);           // Mod time
		lv.setUint16(12, 0, true);           // Mod date
		lv.setUint32(14, crc32(data), true); // CRC-32
		lv.setUint32(18, data.length, true); // Compressed size
		lv.setUint32(22, data.length, true); // Uncompressed size
		lv.setUint16(26, nameBytes.length, true); // File name length
		lv.setUint16(28, 0, true);           // Extra field length

		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);

		localHeaders.push(local);

		// Central directory header (46 bytes + name)
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);

		cv.setUint32(0, 0x02014b50, true);   // Central directory signature
		cv.setUint16(4, 20, true);            // Version made by
		cv.setUint16(6, 20, true);            // Version needed
		cv.setUint16(8, 0, true);             // Flags
		cv.setUint16(10, 0, true);            // Compression: STORE
		cv.setUint16(12, 0, true);            // Mod time
		cv.setUint16(14, 0, true);            // Mod date
		cv.setUint32(16, crc32(data), true);  // CRC-32
		cv.setUint32(20, data.length, true);  // Compressed size
		cv.setUint32(24, data.length, true);  // Uncompressed size
		cv.setUint16(28, nameBytes.length, true); // File name length
		cv.setUint16(30, 0, true);            // Extra field length
		cv.setUint16(32, 0, true);            // File comment length
		cv.setUint16(34, 0, true);            // Disk number start
		cv.setUint16(36, 0, true);            // Internal attributes
		cv.setUint32(38, 0, true);            // External attributes
		cv.setUint32(42, offset, true);       // Local header offset

		central.set(nameBytes, 46);

		centralHeaders.push(central);
		offset += local.length;
	}

	const centralSize = centralHeaders.reduce((s, c) => s + c.length, 0);

	// End of central directory (22 bytes)
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);            // EOCD signature
	ev.setUint16(4, 0, true);                      // Disk number
	ev.setUint16(6, 0, true);                      // Central dir disk
	ev.setUint16(8, files.length, true);            // Entries on disk
	ev.setUint16(10, files.length, true);           // Total entries
	ev.setUint32(12, centralSize, true);            // Central dir size
	ev.setUint32(16, offset, true);                 // Central dir offset
	ev.setUint16(20, 0, true);                      // Comment length

	// Concatenate all parts
	const totalSize = offset + centralSize + 22;
	const zip = new Uint8Array(totalSize);
	let pos = 0;

	for (const lh of localHeaders) {
		zip.set(lh, pos);
		pos += lh.length;
	}
	for (const ch of centralHeaders) {
		zip.set(ch, pos);
		pos += ch.length;
	}
	zip.set(eocd, pos);

	return zip;
}

// CRC-32 lookup table
const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[i] = c;
	}
	return table;
})();

function crc32(data) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}
