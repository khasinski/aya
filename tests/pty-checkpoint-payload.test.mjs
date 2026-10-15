import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {encodeCheckpointPayload,decodeCheckpointPayload,checkpointPayloadSize}=require('../dist-electron/pty-checkpoint-payload.js');
test('compressed checkpoint framing round-trips bytes and exposes bounded raw allocation size',()=>{
 const raw=Buffer.from('ordinary coloured retained history\n'.repeat(10000));
 const compressed=encodeCheckpointPayload(raw);
 assert.ok(compressed.length<raw.length/10);assert.equal(checkpointPayloadSize(compressed),raw.length);assert.deepEqual(decodeCheckpointPayload(compressed),raw);
});
test('compression bombs, forged lengths, trailing corruption and unknown frames refuse',()=>{
 const raw=Buffer.alloc(1024*1024,65),encoded=encodeCheckpointPayload(raw);
 const tooSmall=Buffer.from(encoded);tooSmall.writeUInt32BE(1024,8);
 assert.throws(()=>decodeCheckpointPayload(tooSmall),{code:'ERR_BUFFER_TOO_LARGE'},'inflation must stop at its allocation limit, before a later length-mismatch check');
 const tooLarge=Buffer.from(encoded);tooLarge.writeUInt32BE(64*1024*1024+1,8);assert.throws(()=>decodeCheckpointPayload(tooLarge),/decoded-byte limit/);
 const wrongLength=Buffer.from(encoded);wrongLength.writeUInt32BE(raw.length+1,8);assert.throws(()=>decodeCheckpointPayload(wrongLength),/length mismatch/);
 const corrupt=Buffer.from(encoded);corrupt[corrupt.length-1]^=0xff;assert.throws(()=>decodeCheckpointPayload(corrupt));
 assert.throws(()=>decodeCheckpointPayload(Buffer.alloc(20)));assert.throws(()=>decodeCheckpointPayload(encoded.subarray(0,10)));
});
