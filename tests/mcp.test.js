/**
 * Buyer half of the MCP transport (specs/transports-v2/mcp.md): paying an x402-gated MCP
 * TOOL, as opposed to an HTTP endpoint. Covers challenge detection (both formats the spec
 * allows), the raw-JSON payment in `_meta`, and the never-loop guarantee.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createX402ToolCaller, parseToolChallenge, withPaymentMeta, readSettlement,
    PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY
} from '../src/mcp.js';

const REQ = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0xMerchant',
    maxTimeoutSeconds: 60,
    extra: {
        name: 'USDC',
        version: '2'
    },
};
const challengeBody = () => ({
    x402Version: 2,
    resource: { url: 'mcp://tool/analysis' },
    accepts: [REQ]
});

const structuredChallenge = () => ({
    isError: true,
    structuredContent: challengeBody()
});
const textOnlyChallenge = () => ({
    isError: true,
    content: [{
        type: 'text',
        text: JSON.stringify(challengeBody())
    }],
});

/** A caller wired to fakes: authorize returns a signing artifact, signToPayload signs it. */
const caller = (over = {}) => createX402ToolCaller({
    apiKey: 'K',
    walletId: 'wallet-1',
    signToPayload: async () => ({
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: { signature: '0xsig' }
    }),
    fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            scheme: 'eip712',
            signing: { message: {} }
        }),
    }),
    ...over,
});

test('parses a challenge from structuredContent (preferred)', () => {
    assert.equal(parseToolChallenge(structuredChallenge()).x402Version, 2);
});

test('falls back to parsing content[0].text', () => {
    // The spec REQUIRES servers to send both, but a text-only server is still payable —
    // treating it as unpayable would strand the user.
    assert.equal(parseToolChallenge(textOnlyChallenge()).accepts[0].network, 'eip155:8453');
});

test('an ordinary tool error is NOT a payment challenge', () => {
    assert.equal(parseToolChallenge({
        isError: true,
        content: [{
            type: 'text',
            text: 'boom'
        }]
    }), null);
    assert.equal(parseToolChallenge({
        isError: true,
        structuredContent: { oops: 1 }
    }), null);
    assert.equal(parseToolChallenge({ content: []}), null); // success result
    assert.equal(parseToolChallenge(undefined), null);
});

test('pays a challenged tool and retries ONCE with the payment in _meta', async () => {
    const calls = [];
    const callTool = async (params) => {
        calls.push(params);
        return calls.length === 1
            ? structuredChallenge()
            : {
                content: [{
                    type: 'text',
                    text: 'result'
                }],
                _meta: {
                    [PAYMENT_RESPONSE_META_KEY]: {
                        success: true,
                        transaction: '0xtx'
                    }
                }
            };
    };
    const res = await caller()(callTool, {
        name: 'analysis',
        arguments: { t: 'AAPL' }
    });

    assert.equal(calls.length, 2);
    // The payment is a RAW OBJECT — no base64 anywhere on this transport.
    const sent = calls[1]._meta[PAYMENT_META_KEY];
    assert.equal(typeof sent, 'object');
    assert.equal(sent.x402Version, 2);
    // The original arguments survive the retry.
    assert.deepEqual(calls[1].arguments, { t: 'AAPL' });
    assert.equal(res.content[0].text, 'result');
    assert.equal(readSettlement(res).transaction, '0xtx');
});

test('NEVER loops — a second challenge is returned, not re-paid', async () => {
    // Re-paying a still-challenged call risks paying twice for one call.
    let n = 0;
    const callTool = async () => { n += 1; return structuredChallenge(); };
    const res = await caller()(callTool, { name: 'analysis' });
    assert.equal(n, 2);
    assert.equal(res.isError, true);
});

test('a non-challenge result passes through untouched, unpaid', async () => {
    let n = 0;
    const ok = {
        content: [{
            type: 'text',
            text: 'free'
        }]
    };
    const res = await caller()(async () => { n += 1; return ok; }, { name: 'free_tool' });
    assert.equal(n, 1);
    assert.deepEqual(res, ok);
});

test('returns the challenge unpaid when allowedNetworks excludes every option', async () => {
    let n = 0;
    const res = await caller({ allowedNetworks: ['solana:xyz']})(
        async () => { n += 1; return structuredChallenge(); }, { name: 'analysis' }
    );
    assert.equal(n, 1); // never retried
    assert.equal(res.isError, true); // caller sees the price and decides
});

test('withPaymentMeta preserves any _meta already on the params', () => {
    const out = withPaymentMeta({
        name: 't',
        _meta: { 'my/own': 'kept' }
    }, { x402Version: 2 });
    assert.equal(out._meta['my/own'], 'kept');
    assert.equal(out._meta[PAYMENT_META_KEY].x402Version, 2);
});

test('requires walletId and a local signer (non-custodial)', () => {
    assert.throws(() => createX402ToolCaller({ signToPayload: () => {} }), /walletId is required/);
    assert.throws(() => createX402ToolCaller({ walletId: 'w' }), /signToPayload is required/);
});
