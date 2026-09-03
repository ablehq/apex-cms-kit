// @ts-nocheck — vendored MD5 algorithm (bit-twiddling); verified in tests/admin-md5.test.js.
// A small, self-contained MD5 (public-domain algorithm, Joseph Myers style) used
// ONLY to produce the base64 content-MD5 checksum ActiveStorage's signed direct
// upload requires (plan §5 lists spark-md5 as the Keus dependency for exactly this).
// Inlining it keeps the GLC admin's dependency set flat — no spark-md5, no bricks.
// Web Crypto has no MD5, so this is the one place it is unavoidable; it is verified
// against the RFC 1321 test vectors in tests/admin-md5.test.js.

function toWords(bytes) {
	const words = [];
	for (let i = 0; i < bytes.length * 8; i += 8) {
		words[i >> 5] |= (bytes[i / 8] & 0xff) << (i % 32);
	}
	return words;
}

function add32(a, b) {
	return (a + b) & 0xffffffff;
}

function rol(num, cnt) {
	return (num << cnt) | (num >>> (32 - cnt));
}

function cmn(q, a, b, x, s, t) {
	return add32(rol(add32(add32(a, q), add32(x, t)), s), b);
}
function ff(a, b, c, d, x, s, t) {
	return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
	return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
	return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
	return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md5cycle(state, k) {
	let [a, b, c, d] = state;
	a = ff(a, b, c, d, k[0], 7, -680876936);
	d = ff(d, a, b, c, k[1], 12, -389564586);
	c = ff(c, d, a, b, k[2], 17, 606105819);
	b = ff(b, c, d, a, k[3], 22, -1044525330);
	a = ff(a, b, c, d, k[4], 7, -176418897);
	d = ff(d, a, b, c, k[5], 12, 1200080426);
	c = ff(c, d, a, b, k[6], 17, -1473231341);
	b = ff(b, c, d, a, k[7], 22, -45705983);
	a = ff(a, b, c, d, k[8], 7, 1770035416);
	d = ff(d, a, b, c, k[9], 12, -1958414417);
	c = ff(c, d, a, b, k[10], 17, -42063);
	b = ff(b, c, d, a, k[11], 22, -1990404162);
	a = ff(a, b, c, d, k[12], 7, 1804603682);
	d = ff(d, a, b, c, k[13], 12, -40341101);
	c = ff(c, d, a, b, k[14], 17, -1502002290);
	b = ff(b, c, d, a, k[15], 22, 1236535329);

	a = gg(a, b, c, d, k[1], 5, -165796510);
	d = gg(d, a, b, c, k[6], 9, -1069501632);
	c = gg(c, d, a, b, k[11], 14, 643717713);
	b = gg(b, c, d, a, k[0], 20, -373897302);
	a = gg(a, b, c, d, k[5], 5, -701558691);
	d = gg(d, a, b, c, k[10], 9, 38016083);
	c = gg(c, d, a, b, k[15], 14, -660478335);
	b = gg(b, c, d, a, k[4], 20, -405537848);
	a = gg(a, b, c, d, k[9], 5, 568446438);
	d = gg(d, a, b, c, k[14], 9, -1019803690);
	c = gg(c, d, a, b, k[3], 14, -187363961);
	b = gg(b, c, d, a, k[8], 20, 1163531501);
	a = gg(a, b, c, d, k[13], 5, -1444681467);
	d = gg(d, a, b, c, k[2], 9, -51403784);
	c = gg(c, d, a, b, k[7], 14, 1735328473);
	b = gg(b, c, d, a, k[12], 20, -1926607734);

	a = hh(a, b, c, d, k[5], 4, -378558);
	d = hh(d, a, b, c, k[8], 11, -2022574463);
	c = hh(c, d, a, b, k[11], 16, 1839030562);
	b = hh(b, c, d, a, k[14], 23, -35309556);
	a = hh(a, b, c, d, k[1], 4, -1530992060);
	d = hh(d, a, b, c, k[4], 11, 1272893353);
	c = hh(c, d, a, b, k[7], 16, -155497632);
	b = hh(b, c, d, a, k[10], 23, -1094730640);
	a = hh(a, b, c, d, k[13], 4, 681279174);
	d = hh(d, a, b, c, k[0], 11, -358537222);
	c = hh(c, d, a, b, k[3], 16, -722521979);
	b = hh(b, c, d, a, k[6], 23, 76029189);
	a = hh(a, b, c, d, k[9], 4, -640364487);
	d = hh(d, a, b, c, k[12], 11, -421815835);
	c = hh(c, d, a, b, k[15], 16, 530742520);
	b = hh(b, c, d, a, k[2], 23, -995338651);

	a = ii(a, b, c, d, k[0], 6, -198630844);
	d = ii(d, a, b, c, k[7], 10, 1126891415);
	c = ii(c, d, a, b, k[14], 15, -1416354905);
	b = ii(b, c, d, a, k[5], 21, -57434055);
	a = ii(a, b, c, d, k[12], 6, 1700485571);
	d = ii(d, a, b, c, k[3], 10, -1894986606);
	c = ii(c, d, a, b, k[10], 15, -1051523);
	b = ii(b, c, d, a, k[1], 21, -2054922799);
	a = ii(a, b, c, d, k[8], 6, 1873313359);
	d = ii(d, a, b, c, k[15], 10, -30611744);
	c = ii(c, d, a, b, k[6], 15, -1560198380);
	b = ii(b, c, d, a, k[13], 21, 1309151649);
	a = ii(a, b, c, d, k[4], 6, -145523070);
	d = ii(d, a, b, c, k[11], 10, -1120210379);
	c = ii(c, d, a, b, k[2], 15, 718787259);
	b = ii(b, c, d, a, k[9], 21, -343485551);

	state[0] = add32(a, state[0]);
	state[1] = add32(b, state[1]);
	state[2] = add32(c, state[2]);
	state[3] = add32(d, state[3]);
}

/** Compute the raw 16-byte MD5 digest of a Uint8Array. */
export function md5Bytes(bytes) {
	const n = bytes.length;
	const state = [1732584193, -271733879, -1732584194, 271733878];
	let i;
	for (i = 64; i <= n; i += 64) {
		md5cycle(state, toWords(bytes.subarray(i - 64, i)));
	}
	const tail = bytes.subarray(i - 64);
	const tmp = new Uint8Array(64);
	tmp.set(tail);
	tmp[tail.length] = 0x80;
	let words;
	if (tail.length > 55) {
		md5cycle(state, toWords(tmp));
		tmp.fill(0);
	}
	words = toWords(tmp);
	// 64-bit length in bits, little-endian; n < 2^29 so the high word stays 0.
	words[14] = n * 8;
	md5cycle(state, words);

	const out = new Uint8Array(16);
	for (let j = 0; j < 4; j += 1) {
		out[j * 4] = state[j] & 0xff;
		out[j * 4 + 1] = (state[j] >> 8) & 0xff;
		out[j * 4 + 2] = (state[j] >> 16) & 0xff;
		out[j * 4 + 3] = (state[j] >> 24) & 0xff;
	}
	return out;
}

function bytesToBase64(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function bytesToHex(bytes) {
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/** Base64 of the raw digest — the form ActiveStorage's `checksum` expects. */
export function md5Base64(bytes) {
	return bytesToBase64(md5Bytes(bytes));
}

/** Hex digest, for test-vector verification. */
export function md5Hex(bytes) {
	return bytesToHex(md5Bytes(bytes));
}
