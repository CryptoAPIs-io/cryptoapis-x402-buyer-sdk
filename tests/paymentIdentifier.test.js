/**
 * `payment-identifier` extension on the buyer side: the CALLER supplies an idempotency id
 * that the facilitator uses as its dedup key, so retrying a request whose response never
 * arrived settles once rather than twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPaymentIdentifier } from '../src/paymentPayload.js';

const payload = () => ({
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: { signature: '0xsig' },
});

test('attaches the extension for a well-formed id', () => {
    const out = withPaymentIdentifier(payload(), 'pay_7d5d747be160e280504c099d984bcfe0');
    assert.equal(out.extensions['payment-identifier'].info.id, 'pay_7d5d747be160e280504c099d984bcfe0');
    // the rest of the payload is untouched
    assert.equal(out.scheme, 'exact');
    assert.equal(out.payload.signature, '0xsig');
});

test('accepts the exact spec bounds (16 and 128 chars)', () => {
    assert.ok(withPaymentIdentifier(payload(), 'a'.repeat(16)).extensions);
    assert.ok(withPaymentIdentifier(payload(), 'a'.repeat(128)).extensions);
});

test('DROPS an out-of-bounds id rather than sending one the facilitator would ignore', () => {
    // A silently-ignored idempotency key is worse than an obviously absent one.
    assert.equal(withPaymentIdentifier(payload(), 'a'.repeat(15)).extensions, undefined);
    assert.equal(withPaymentIdentifier(payload(), 'a'.repeat(129)).extensions, undefined);
});

test('is a no-op with no id, leaving the payload unchanged', () => {
    assert.deepEqual(withPaymentIdentifier(payload()), payload());
    assert.deepEqual(withPaymentIdentifier(payload(), undefined), payload());
    assert.deepEqual(withPaymentIdentifier(payload(), 12345), payload());
});

test('preserves any extensions already on the payload', () => {
    const base = {
        ...payload(),
        extensions: { other: { info: {} } }
    };
    const out = withPaymentIdentifier(base, 'a'.repeat(20));
    assert.ok(out.extensions.other);
    assert.ok(out.extensions['payment-identifier']);
});
