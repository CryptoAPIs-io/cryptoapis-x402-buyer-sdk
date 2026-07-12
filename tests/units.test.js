/**
 * Unit tests for the authorize client (posts to /authorize with auth, throws on
 * non-2xx) + the payment-payload helpers (parse402, buildEip712Payload, header
 * encode). `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizeClient } from '../src/authorizeClient.js';
import {
    parse402, buildEip712Payload, encodePaymentHeader
} from '../src/paymentPayload.js';

/** A fetch mock returning body/status, capturing the last call. */
function mockFetch(body, status = 200) {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({
            url,
            opts
        });
        return {
            ok: status >= 200 && status < 300,
            status,
            async json() { return body; },
            async text() { return JSON.stringify(body); },
        };
    };
    fn.calls = calls;
    return fn;
}

test('authorize requires apiKey', () => {
    assert.throws(() => createAuthorizeClient({}), /apiKey is required/);
});

test('authorize posts {paymentRequirements, walletId} with x-api-key', async () => {
    const fetchImpl = mockFetch({
        scheme: 'eip712',
        signing: { primaryType: 'X' }
    });
    const c = createAuthorizeClient({
        apiKey: 'K1',
        baseUrl: 'https://buyer/x402/buyer',
        fetchImpl
    });
    const res = await c.authorize({
        paymentRequirements: { a: 1 },
        walletId: 'w9'
    });
    assert.equal(res.scheme, 'eip712');
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://buyer/x402/buyer/authorize');
    assert.equal(call.opts.headers['x-api-key'], 'K1');
    assert.deepEqual(JSON.parse(call.opts.body), {
        paymentRequirements: { a: 1 },
        walletId: 'w9'
    });
});

test('authorize throws on non-2xx (budget/auth error)', async () => {
    const c = createAuthorizeClient({
        apiKey: 'K',
        fetchImpl: mockFetch({ error: 'over_budget' }, 403)
    });
    await assert.rejects(() => c.authorize({
        paymentRequirements: {},
        walletId: 'w'
    }), /403/);
});

test('parse402 extracts accepts (and tolerates a malformed body)', () => {
    assert.deepEqual(parse402({ accepts: [{ a: 1 }]}), [{ a: 1 }]);
    assert.deepEqual(parse402({}), []);
    assert.deepEqual(parse402(null), []);
});

test('buildEip712Payload → the x402 PaymentPayload wire shape', () => {
    const p = buildEip712Payload({
        network: 'eip155:8453',
        authorization: { from: '0xB' },
        signature: '0xsig'
    });
    assert.equal(p.x402Version, 2);
    assert.equal(p.scheme, 'exact'); // wire scheme is always exact
    assert.equal(p.network, 'eip155:8453');
    assert.deepEqual(p.payload, {
        signature: '0xsig',
        authorization: { from: '0xB' }
    });
});

test('encodePaymentHeader round-trips', () => {
    const p = buildEip712Payload({
        network: 'eip155:8453',
        authorization: {},
        signature: '0xs'
    });
    const decoded = JSON.parse(Buffer.from(encodePaymentHeader(p), 'base64').toString('utf8'));
    assert.equal(decoded.scheme, 'exact');
});
