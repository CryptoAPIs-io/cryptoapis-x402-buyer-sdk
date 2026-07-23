/**
 * Tests for the wallet-registry client (BL-0116): createWallet posts a well-formed
 * body + returns the walletId; listWallets GETs; and both validate/surface errors.
 * Mocked fetch. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletsClient } from '../src/walletsClient.js';

/** A Response-like double. */
function resp({ status = 200, body = {} } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

test('createWallet POSTs /wallets with the x-api-key + body and returns the walletId', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
        seen = {
            url: String(url),
            init
        };
        return resp({
            body: {
                walletId: 'w-123',
                address: '0xabc',
                type: 'address'
            }
        });
    };
    const client = createWalletsClient({
        apiKey: 'K',
        fetchImpl
    });
    const out = await client.createWallet({
        blockchain: 'base',
        network: 'eip155:8453',
        address: '0xabc'
    });
    assert.ok(seen.url.endsWith('/wallets'));
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['x-api-key'], 'K');
    assert.deepEqual(JSON.parse(seen.init.body).network, 'eip155:8453');
    assert.equal(out.walletId, 'w-123');
});

test('createWallet throws LOCALLY when network is missing (no round-trip)', async () => {
    let called = false;
    const client = createWalletsClient({
        apiKey: 'K',
        fetchImpl: async () => { called = true; return resp(); }
    });
    await assert.rejects(() => client.createWallet({ address: '0xabc' }), /`network`.*CAIP-2/);
    assert.equal(called, false); // never hit the network
});

test('createWallet throws LOCALLY when neither/both of address|xpub given', async () => {
    const client = createWalletsClient({
        apiKey: 'K',
        fetchImpl: async () => resp()
    });
    await assert.rejects(() => client.createWallet({ network: 'eip155:8453' }), /exactly one of/);
    await assert.rejects(
        () => client.createWallet({
            network: 'eip155:8453',
            address: '0xabc',
            xpub: 'xpub-1'
        }),
        /exactly one of/
    );
});

test('createWallet surfaces a non-2xx server error', async () => {
    const client = createWalletsClient({
        apiKey: 'K',
        fetchImpl: async () => resp({
            status: 400,
            body: { error: 'malformed_request' }
        })
    });
    await assert.rejects(
        () => client.createWallet({
            network: 'eip155:8453',
            address: '0xabc'
        }),
        /create failed: 400/
    );
});

test('listWallets GETs /wallets and returns the list', async () => {
    const wallets = [{
        walletId: 'w1',
        address: '0xabc',
        type: 'address',
        network: 'eip155:8453'
    }];
    let method;
    const client = createWalletsClient({
        apiKey: 'K',
        fetchImpl: async (url, init) => { method = init.method; return resp({ body: wallets }); }
    });
    const out = await client.listWallets();
    assert.equal(method, 'GET');
    assert.deepEqual(out, wallets);
});

test('createWalletsClient requires an apiKey', () => {
    assert.throws(() => createWalletsClient({}), /apiKey is required/);
});
