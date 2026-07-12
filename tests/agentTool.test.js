/**
 * Tests for the agent-tool adapters: the framework-neutral core (createPayTool),
 * the function-calling vendor shapes, and the LangChain/AI-SDK builders with injected
 * deps (so no framework install is needed to test). `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createPayTool, X402_PAY_PARAMETERS
} from '../src/agentTool.js';
import { x402PayFunction } from '../src/function-calling.js';
import { x402PayTool as aiSdkTool } from '../src/ai-sdk.js';
import { x402PayTool as langchainTool } from '../src/langchain.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reqs = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: USDC,
    payTo: '0xM',
    maxTimeoutSeconds: 300,
    extra: {}
};

/** A Response double. */
function resp({ status = 200, body = {}, headers = {} } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        clone() { return this; },
        headers: { get: (k) => headers[k] ?? null },
        async json() { return body; },
        async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
}

/** A fetch that 402s once, authorizes, then returns paid with an X-PAYMENT-RESPONSE. */
function payingFetch() {
    return async (url, init) => {
        const u = String(url);
        if (u.endsWith('/authorize')) {
            return resp({
                status: 200,
                body: {
                    authorized: true,
                    scheme: 'eip712',
                    signing: {
                        domain: {},
                        types: {},
                        primaryType: 'X',
                        message: { from: '0xB' }
                    }
                }
            });
        }
        if (init && init.headers && init.headers['x-payment']) {
            return resp({
                status: 200,
                body: { data: 'paid' },
                headers: { 'x-payment-response': Buffer.from(JSON.stringify({ transaction: '0xtx' })).toString('base64') }
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
}

const config = () => ({
    apiKey: 'K',
    walletId: 'w1',
    signer: { signTypedData: async () => '0xsig' },
    fetchImpl: payingFetch()
});

test('createPayTool: name/description/JSON-Schema parameters', () => {
    const t = createPayTool(config());
    assert.equal(t.name, 'x402_pay');
    assert.ok(t.description.length > 20);
    assert.deepEqual(t.parameters, X402_PAY_PARAMETERS);
    assert.equal(typeof t.execute, 'function');
});

test('createPayTool.execute: pays a 402 and reports settlement', async () => {
    const t = createPayTool(config());
    const r = await t.execute({ url: 'https://api/premium' });
    assert.equal(r.status, 200);
    assert.equal(r.paid, true);
    assert.equal(r.settlement.transaction, '0xtx');
    assert.equal(r.body, JSON.stringify({ data: 'paid' }));
});

test('createPayTool.execute: non-402 → paid:false, no settlement', async () => {
    const fetchImpl = async () => resp({
        status: 200,
        body: { free: true }
    });
    const t = createPayTool({
        apiKey: 'K',
        walletId: 'w1',
        signer: { signTypedData: async () => '0x' },
        fetchImpl
    });
    const r = await t.execute({ url: 'https://api/free' });
    assert.equal(r.paid, false);
    assert.equal(r.settlement, undefined);
});

test('function-calling: OpenAI / Anthropic / Gemini tool shapes + run()', async () => {
    const pay = x402PayFunction(config());
    assert.equal(pay.openaiTool.type, 'function');
    assert.equal(pay.openaiTool.function.name, 'x402_pay');
    assert.equal(pay.anthropicTool.input_schema.type, 'object');
    assert.equal(pay.geminiTool.name, 'x402_pay');
    const r = await pay.run({ url: 'https://api/premium' });
    assert.equal(r.paid, true);
});

test('ai-sdk: builds an AI SDK tool via injected {tool, jsonSchema}', async () => {
    // Inject fakes for the `ai` module (no real dep needed).
    const fakeAi = {
        tool: (def) => ({
            __tool: true,
            description: def.description,
            parameters: def.parameters,
            execute: def.execute
        }),
        jsonSchema: (s) => ({ __jsonSchema: s }),
    };
    const t = await aiSdkTool(config(), fakeAi);
    assert.equal(t.__tool, true);
    assert.equal(t.parameters.__jsonSchema.type, 'object');
    const r = await t.execute({ url: 'https://api/premium' });
    assert.equal(r.paid, true);
});

test('langchain: builds a DynamicStructuredTool via injected deps', async () => {
    // Minimal fakes for DynamicStructuredTool + zod.
    class FakeDST {
        constructor(def) { Object.assign(this, def); }
    }
    const z = {
        object: (shape) => ({ __shape: shape }),
        string: () => ({
            describe: () => ({}),
            optional: () => ({})
        }),
        enum: () => ({ optional: () => ({}) }),
    };
    const t = await langchainTool(config(), {
        DynamicStructuredTool: FakeDST,
        z
    });
    assert.equal(t.name, 'x402_pay');
    assert.ok(t.description.length > 20);
    const out = await t.func({ url: 'https://api/premium' });
    assert.equal(JSON.parse(out).paid, true);
});
