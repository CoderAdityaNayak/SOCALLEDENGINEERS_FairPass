// Checks the browser solver port against the published worked example and against the Node package.
//   node --test frontend/test/x402work.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../src/lib/x402work-core.js'
import * as node from 'x402-work-client'

// Worked example from https://x402.qu.ai/docs/pay.md (amount 4096)
const work = {
  extraNonce1: 'aabbccdd',
  extraNonce2Size: 4,
  previousBlockHash: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  coinbase1: '01000000010000000000000000',
  coinbase2: 'ffffffff0100',
  merkleBranches: ['a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0'],
  version: '20000000',
  bits: '1d00ffff',
  time: '671f8a40',
}
const solution = { extraNonce2: '0x0000002a', time: '0x671f8a40', nonce: '0x00000375' }

test('worked example: header, digest and score match the published values', () => {
  const header = core.workHeader(work, solution)
  assert.equal(
    core.bytesToHex(header),
    '0000002004030201080706050c0b0a09100f0e0d14131211181716151c1b1a19201f1e1da557977aa12f766e3b32c1b95fa6afa37fb866cb3eaf4eba613bd6ffa3ad172e408a1f67ffff001d75030000',
  )
  const digest = core.workDigest(header)
  assert.equal(core.bytesToHex(digest), 'b90a83c83afae6d6a9f6456afb779760a512b8114610b67c1a41931cfb920b00')
  assert.equal(core.workScore(digest), 0x000b92fb1c93411a7cb6104611b812a5609777fb6a45f6a9d6e6fa3ac8830ab9n)
  assert.ok(core.workScore(digest) <= core.workTarget(4096))
})

test('byte-reversed nonce fails the target (negative case)', () => {
  const digest = core.workDigest(core.workHeader(work, { ...solution, nonce: '0x75030000' }))
  assert.equal(core.workScore(digest), 0x0035fb5e1451ddfd18474d34b1f7dd3018b1a8853172b560b2661652ea83647bn)
  assert.ok(core.workScore(digest) > core.workTarget(4096))
})

test('solver finds the published nonce from extraNonce2 0x0000002a', () => {
  const offer = {
    amount: '4096',
    extra: { profile: core.PROFILE, job: { expiresAt: Math.floor(Date.now() / 1000) + 60, work } },
  }
  const { solution: s } = core.solveWork(offer, { extraNonce2: '0x0000002a' })
  assert.equal(s.nonce, '0x00000375')
})

test('solutions from the browser port verify with the Node package (random jobs)', () => {
  for (let i = 0; i < 5; i++) {
    const rand = (n) => core.bytesToHex(crypto.getRandomValues(new Uint8Array(n)))
    const w = { ...work, previousBlockHash: rand(32), extraNonce1: rand(4), merkleBranches: [rand(32), rand(32)] }
    const offer = { amount: '65536', extra: { profile: core.PROFILE, job: { expiresAt: Math.floor(Date.now() / 1000) + 60, work: w } } }
    const t = performance.now()
    const { solution: s, guesses } = core.solveWork(offer)
    const nodeScore = node.workScore(node.workDigest(core.PROFILE, node.workHeader(w, s)))
    assert.ok(nodeScore <= node.workTarget(65536))
    if (i === 0) console.log(`    ${guesses} guesses in ${(performance.now() - t).toFixed(0)} ms (${Math.round(guesses / ((performance.now() - t) / 1000))} guesses/s in Node)`)
  }
})

test('base64 header helpers round-trip and match the Node encoding', () => {
  const v = { x402Version: 2, note: 'ünïcode ok' }
  assert.deepEqual(core.decodeHeader(core.encodeHeader(v)), v)
  assert.equal(core.encodeHeader(v), node.encodeHeader(v))
})
