/**
 * Tests for the x402 v2 HTTP transport on the BUYER side: reading the challenge from the
 * `PAYMENT-REQUIRED` header (including from a merchant that sends no body at all), sending
 * the credential on `PAYMENT-SIGNATURE`, echoing the chosen requirement as `accepted`, and
 * reading the receipt from `PAYMENT-RESPONSE`.
 *
 * The v1 path (body challenge, `X-PAYMENT`, `X-PAYMENT-RESPONSE`) must keep working —
 * our own merchants speak it. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createX402Fetch } from '../src/x402Fetch.js';
import {
    decodePaymentRequired, readChallenge
} from '../src/paymentPayload.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reqs = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: USDC,
    payTo: '0xMerchant',
    maxTimeoutSeconds: 300,
    extra: {},
};
const challenge = {
    x402Version: 2,
    resource: { url: 'https://api/x' },
    accepts: [reqs],
    error: 'payment required',
};

/** Base64-encode an object as a header value. */
function b64(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Decode a base64 header value. */
function unb64(v) {
    return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
}

/** A Response-like double with real headers. */
function resp({ status = 200, body = {}, headers = {}, json = true } = {}) {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
        clone() { return this; },
        async json() {
            if (!json) {
                throw new Error('not json');
            }
            return body;
        },
        async text() { return JSON.stringify(body); },
    };
}

const authorizeResponse = {
    scheme: 'eip712',
    signing: {
        domain: {
            name: 'USD Coin',
            version: '2',
            chainId: 8453,
            verifyingContract: USDC
        },
        types: {
            TransferWithAuthorization: [{
                name: 'from',
                type: 'address'
            }]
        },
        primaryType: 'TransferWithAuthorization',
        message: {
            from: '0xBuyer',
            to: '0xMerchant',
            value: '10000',
            validAfter: '0',
            validBefore: '999',
            nonce: '0x11'
        },
    },
};

/**
 * Drive one pay flow against a merchant double.
 *
 * @param {Object} params inputs
 * @param {Object} params.first the merchant's 402 response double
 * @param {Object} [params.paid] the merchant's post-payment response double
 * @return {Promise<Object>} what the merchant saw and returned
 */
async function payAgainst({ first, paid }) {
    const seen = { retryHeaders: null };
    let n = 0;
    const fetchImpl = async (url, init) => {
        n += 1;
        if (n === 1) {
            return first;
        }
        if (String(url).includes('/authorize')) {
            return resp({ body: authorizeResponse });
        }
        seen.retryHeaders = init.headers;
        return paid ?? resp({
            status: 200,
            body: { ok: true }
        });
    };
    const f = createX402Fetch({
        apiKey: 'K',
        walletId: 'w1',
        signer: { signTypedData: async () => '0xsig' },
        fetchImpl,
    });
    seen.response = await f('https://api/x');
    return seen;
}

test('pays a v2 merchant that sends the challenge ONLY in the PAYMENT-REQUIRED header', async () => {
    // The v2 transport treats the body as a server concern — this merchant sends none.
    const seen = await payAgainst({
        first: resp({
            status: 402,
            json: false,
            headers: { 'payment-required': b64(challenge) },
        }),
    });
    assert.equal(seen.response.status, 200);
    assert.ok(seen.retryHeaders['payment-signature'], 'must send PAYMENT-SIGNATURE');
});

test('REGRESSION: still pays a v1 merchant that sends the challenge in the body only', async () => {
    const seen = await payAgainst({
        first: resp({
            status: 402,
            body: challenge
        }),
    });
    assert.equal(seen.response.status, 200);
    assert.ok(seen.retryHeaders['x-payment'], 'must still send X-PAYMENT');
});

test('the credential goes out on BOTH header names with the same value', async () => {
    const seen = await payAgainst({
        first: resp({
            status: 402,
            body: challenge,
            headers: { 'payment-required': b64(challenge) },
        }),
    });
    assert.equal(seen.retryHeaders['payment-signature'], seen.retryHeaders['x-payment']);
});

test('the payload echoes the chosen requirement as `accepted` (v2 §5.2.2) AND keeps flat scheme/network', async () => {
    const seen = await payAgainst({
        first: resp({
            status: 402,
            headers: { 'payment-required': b64(challenge) },
            json: false,
        }),
    });
    const payload = unb64(seen.retryHeaders['payment-signature']);
    // v2 readers use `accepted`...
    assert.deepEqual(payload.accepted, reqs);
    // ...and a v1 merchant matching on top-level network still pairs correctly.
    assert.equal(payload.network, 'eip155:8453');
    assert.equal(payload.scheme, 'exact');
    assert.equal(payload.x402Version, 2);
});

test('the header challenge wins when the body disagrees', async () => {
    const bodyChallenge = {
        ...challenge,
        accepts: [{
            ...reqs,
            network: 'eip155:1',
            payTo: '0xWrong'
        }],
    };
    const seen = await payAgainst({
        first: resp({
            status: 402,
            body: bodyChallenge,
            headers: { 'payment-required': b64(challenge) },
        }),
    });
    const payload = unb64(seen.retryHeaders['payment-signature']);
    assert.equal(payload.network, 'eip155:8453', 'must pay the header challenge, not the body');
    assert.equal(payload.accepted.payTo, '0xMerchant');
});

test('reads the settlement receipt from PAYMENT-RESPONSE or X-PAYMENT-RESPONSE', async () => {
    const settlement = {
        success: true,
        transaction: '0xdead',
        network: 'eip155:8453'
    };
    for (const name of ['payment-response', 'x-payment-response']) {
        const seen = await payAgainst({
            first: resp({
                status: 402,
                body: challenge
            }),
            paid: resp({
                status: 200,
                body: { ok: true },
                headers: { [name]: b64(settlement) }
            }),
        });
        assert.equal(seen.response.headers.get(name), b64(settlement));
    }
});

test('a merchant offering nothing payable still hands the 402 back untouched', async () => {
    const seen = await payAgainst({
        first: resp({
            status: 402,
            json: false
        }),
    });
    assert.equal(seen.response.status, 402);
    assert.equal(seen.retryHeaders, null, 'must not retry when there is no challenge');
});

test('decodePaymentRequired / readChallenge handle absent and malformed input', () => {
    assert.equal(decodePaymentRequired(undefined), null);
    assert.equal(decodePaymentRequired(''), null);
    assert.equal(decodePaymentRequired('!!not base64 json!!'), null);
    assert.deepEqual(readChallenge({ headerValue: b64(challenge) }), [reqs]);
    assert.deepEqual(readChallenge({ body: challenge }), [reqs]);
    // A malformed header must not shadow a usable body.
    assert.deepEqual(readChallenge({
        headerValue: 'garbage',
        body: challenge
    }), [reqs]);
    assert.deepEqual(readChallenge({}), []);
});
