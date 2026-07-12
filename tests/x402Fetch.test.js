/**
 * Tests for the x402 buyer fetch wrapper: non-402 passthrough, the full pay flow
 * (402 → authorize → sign → retry with X-PAYMENT), network selection, and the
 * non-custodial signer contract. Mocked fetch + signer. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createX402Fetch, selectRequirements
} from '../src/x402Fetch.js';

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

/** A Response-like double. */
function resp({ status = 200, body = {}, text = '' } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        clone() { return this; },
        async json() { return body; },
        async text() { return text || JSON.stringify(body); },
    };
}

/** The EVM /authorize response (scheme eip712 + the typed-data to sign). */
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

test('non-402 response passes through untouched (no payment)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1; return resp({
            status: 200,
            body: { ok: true }
        });
    };
    const f = createX402Fetch({
        apiKey: 'K',
        walletId: 'w1',
        signer: { signTypedData: async () => '0xsig' },
        fetchImpl
    });
    const r = await f('https://api/x');
    assert.equal(r.status, 200);
    assert.equal(calls, 1); // only the original request
});

test('402 → authorize → sign → retry with X-PAYMENT → 200', async () => {
    const seen = {
        authorizeBody: null,
        retryHeaders: null
    };
    let n = 0;
    const fetchImpl = async (url, init) => {
        n += 1;
        if (n === 1) {
            return resp({
                status: 402,
                body: {
                    x402Version: 2,
                    accepts: [reqs]
                }
            });
        }
        if (String(url).endsWith('/authorize')) {
            seen.authorizeBody = JSON.parse(init.body);
            return resp({
                status: 200,
                body: authorizeResponse
            });
        }
        // the retry of the original request
        seen.retryHeaders = init.headers;
        return resp({
            status: 200,
            body: { data: 'paid resource' }
        });
    };
    let signedPayload;
    const signer = { signTypedData: async (p) => { signedPayload = p; return '0xdeadbeefsig'; } };
    const f = createX402Fetch({
        apiKey: 'K',
        walletId: 'w1',
        signer,
        fetchImpl
    });

    const r = await f('https://api/premium');
    assert.equal(r.status, 200);
    // authorize was called with the merchant requirements + walletId
    assert.deepEqual(seen.authorizeBody.paymentRequirements, reqs);
    assert.equal(seen.authorizeBody.walletId, 'w1');
    // the signer got the typed-data from /authorize (non-custodial: SDK didn't sign)
    assert.equal(signedPayload.primaryType, 'TransferWithAuthorization');
    // the retry carried an X-PAYMENT header encoding the eip712 payload
    const decoded = JSON.parse(Buffer.from(seen.retryHeaders['x-payment'], 'base64').toString('utf8'));
    assert.equal(decoded.scheme, 'exact'); // wire scheme is always 'exact' (family is in network)
    assert.equal(decoded.payload.signature, '0xdeadbeefsig');
    assert.deepEqual(decoded.payload.authorization, authorizeResponse.signing.message);
});

// Each non-EVM scheme: /authorize returns its signing artifact, the matching signer
// method produces the signed tx, and the SDK wraps it as { payload: { transaction } }.
const NON_EVM_CASES = [
    {
        scheme: 'svm-transaction',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        method: 'signSvm',
        signing: { transaction: 'BASE64UNSIGNED' },
        signed: 'BASE64SIGNED'
    },
    {
        scheme: 'tron-transaction',
        network: 'tron:0x2b6653dc',
        method: 'signTron',
        // eslint-disable-next-line camelcase
        signing: { transaction: { raw_data: {} } },
        signed: {
            txID: 'T',
            // eslint-disable-next-line camelcase
            raw_data_hex: 'R',
            signature: ['S']
        }
    },
    {
        scheme: 'utxo-transaction',
        network: 'bip122:000000000019d6689c085ae165831e93',
        method: 'signUtxo',
        signing: { preparedTransaction: { inputs: []} },
        signed: '0100signedhex'
    },
    {
        scheme: 'kaspa-transaction',
        network: 'kaspa:mainnet',
        method: 'signKaspa',
        signing: { preparedTransaction: {} },
        signed: {
            id: 'k',
            inputs: []
        }
    },
    {
        scheme: 'xrp-transaction',
        network: 'xrpl:0',
        method: 'signXrp',
        signing: { transaction: { TransactionType: 'Payment' } },
        signed: '120000SIGNEDBLOB'
    },
];

for (const c of NON_EVM_CASES) {
    test(`${c.scheme}: authorize → ${c.method} → { payload: { transaction } } retry`, async () => {
        const reqsC = {
            ...reqs,
            network: c.network
        };
        let retryHeaders;
        let signerGot;
        const fetchImpl = async (url, init) => {
            const u = String(url);
            if (u.endsWith('/authorize')) {
                return resp({
                    status: 200,
                    body: {
                        scheme: c.scheme,
                        signing: c.signing
                    }
                });
            }
            if (init && init.headers && init.headers['x-payment']) {
                retryHeaders = init.headers; return resp({
                    status: 200,
                    body: { paid: true }
                });
            }
            return resp({
                status: 402,
                body: {
                    x402Version: 2,
                    accepts: [reqsC]
                }
            });
        };
        const signer = { [c.method]: async (arg) => { signerGot = arg; return c.signed; } };
        const f = createX402Fetch({
            apiKey: 'K',
            walletId: 'w1',
            signer,
            fetchImpl
        });

        const r = await f('https://api/premium');
        assert.equal(r.status, 200);
        // signer received the artifact from /authorize (non-custodial)
        assert.ok(signerGot);
        // the X-PAYMENT wraps the SIGNED tx under payload.transaction, correct scheme+network
        const decoded = JSON.parse(Buffer.from(retryHeaders['x-payment'], 'base64').toString('utf8'));
        assert.equal(decoded.scheme, 'exact'); // wire scheme is always 'exact'
        assert.equal(decoded.network, c.network);
        assert.deepEqual(decoded.payload.transaction, c.signed);
    });

    test(`${c.scheme}: missing signer.${c.method} → clear error`, async () => {
        const reqsC = {
            ...reqs,
            network: c.network
        };
        let n = 0;
        const fetchImpl = async (url) => {
            n += 1;
            if (String(url).endsWith('/authorize')) {
                return resp({
                    status: 200,
                    body: {
                        scheme: c.scheme,
                        signing: c.signing
                    }
                });
            }
            if (n === 1) {
                return resp({
                    status: 402,
                    body: {
                        x402Version: 2,
                        accepts: [reqsC]
                    }
                });
            }
            return resp({ status: 200 });
        };
        // signer implements only EVM → the non-EVM scheme must fail clearly
        const f = createX402Fetch({
            apiKey: 'K',
            walletId: 'w1',
            signer: { signTypedData: async () => '0x' },
            fetchImpl
        });
        await assert.rejects(() => f('https://api/premium'), new RegExp(`signer.${c.method} is required`));
    });
}

test('a genuinely unknown scheme throws unsupported_scheme', async () => {
    let n = 0;
    const fetchImpl = async (url) => {
        n += 1;
        if (n === 1) {
            return resp({
                status: 402,
                body: {
                    x402Version: 2,
                    accepts: [{
                        ...reqs,
                        network: 'cosmos:hub'
                    }]
                }
            });
        }
        if (String(url).endsWith('/authorize')) {
            // an unrecognized scheme the SDK has no dispatch for
            return resp({
                status: 200,
                body: {
                    scheme: 'cosmos-adr36',
                    signing: {}
                }
            });
        }
        return resp({ status: 200 });
    };
    const f = createX402Fetch({
        apiKey: 'K',
        walletId: 'w1',
        signer: { signTypedData: async () => '0x' },
        fetchImpl
    });
    await assert.rejects(() => f('https://api/premium'), /unsupported_scheme: cosmos-adr36/);
});

test('402 with no acceptable network → returns the 402 unchanged (no authorize)', async () => {
    let authorizeCalled = false;
    const fetchImpl = async (url) => {
        if (String(url).endsWith('/authorize')) {
            authorizeCalled = true; return resp({
                status: 200,
                body: authorizeResponse
            });
        }
        return resp({
            status: 402,
            body: {
                x402Version: 2,
                accepts: [reqs]
            }
        });
    };
    // allow only Solana → the Base offer is not acceptable
    const f = createX402Fetch({
        apiKey: 'K',
        walletId: 'w1',
        signer: { signTypedData: async () => '0x' },
        allowedNetworks: ['solana:xxx'],
        fetchImpl
    });
    const r = await f('https://api/premium');
    assert.equal(r.status, 402);
    assert.equal(authorizeCalled, false);
});

test('requires walletId + signer (non-custodial guardrails)', () => {
    assert.throws(() => createX402Fetch({
        apiKey: 'K',
        signer: {}
    }), /walletId is required/);
    assert.throws(() => createX402Fetch({
        apiKey: 'K',
        walletId: 'w1'
    }), /signer is required/);
});

test('selectRequirements honors the allowedNetworks allowlist', () => {
    const evm = { network: 'eip155:8453' };
    const sol = { network: 'solana:x' };
    assert.equal(selectRequirements([evm, sol]), evm); // default: first
    assert.equal(selectRequirements([evm, sol], ['solana:x']), sol);
    assert.equal(selectRequirements([evm], ['solana:x']), null); // none acceptable
    assert.equal(selectRequirements([]), null);
});
