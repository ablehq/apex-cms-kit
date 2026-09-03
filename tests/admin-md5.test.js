// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract, run to verify.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { md5Hex, md5Base64 } from '../src/admin/md5.js';

const enc = (s) => new TextEncoder().encode(s);

describe('md5 (checksum for ActiveStorage direct upload)', () => {
	it('matches the RFC 1321 test vectors (hex)', () => {
		assert.equal(md5Hex(enc('')), 'd41d8cd98f00b204e9800998ecf8427e');
		assert.equal(md5Hex(enc('a')), '0cc175b9c0f1b6a831c399e269772661');
		assert.equal(md5Hex(enc('abc')), '900150983cd24fb0d6963f7d28e17f72');
		assert.equal(md5Hex(enc('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0');
		assert.equal(md5Hex(enc('abcdefghijklmnopqrstuvwxyz')), 'c3fcd3d76192e4007dfb496cca67e13b');
		assert.equal(
			md5Hex(enc('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')),
			'd174ab98d277d9f5a5611c2c9f419d9f'
		);
	});

	it('handles the padding boundary cases (multi-block)', () => {
		// 55/56/64 bytes bracket the point where padding needs an extra 512-bit block.
		assert.equal(md5Hex(enc('a'.repeat(55))), 'ef1772b6dff9a122358552954ad0df65');
		assert.equal(md5Hex(enc('a'.repeat(56))), '3b0c8ac703f828b04c6c197006d17218');
		assert.equal(md5Hex(enc('a'.repeat(64))), '014842d480b571495a4a0363793f7367');
	});

	it('produces a base64 digest (the ActiveStorage checksum form)', () => {
		// base64 of the raw md5('abc') digest.
		assert.equal(md5Base64(enc('abc')), 'kAFQmDzST7DWlj99KOF/cg==');
	});
});
