/**
 * Tests for client-side PaymentRequirements validation (BL-0116): catch a malformed
 * merchant 402 (esp. a missing SVM extra.feePayer/decimals) BEFORE the /authorize
 * round-trip. `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    validatePaymentRequirements, familyOf
} from '../src/requirementsValidation.js';

const EVM = 'eip155:8453';
const SVM = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

test('familyOf resolves the family from the CAIP-2 prefix', () => {
    assert.equal(familyOf(EVM), 'evm');
    assert.equal(familyOf(SVM), 'svm');
    assert.equal(familyOf('tron:0x2b6653dc'), 'tron');
    assert.equal(familyOf('bip122:000000000019d6689c085ae165831e93'), 'utxo');
    assert.equal(familyOf('xrpl:0'), 'xrp');
    assert.equal(familyOf('kaspa:mainnet'), 'kaspa');
    assert.equal(familyOf('cosmos:hub'), null);
    assert.equal(familyOf(undefined), null);
});

test('accepts a well-formed EVM requirements', () => {
    assert.doesNotThrow(() => validatePaymentRequirements({
        network: EVM,
        asset: '0xUSDC',
        amount: '10000',
        payTo: '0xseller'
    }));
});

test('accepts a well-formed SVM requirements (feePayer + decimals present)', () => {
    assert.doesNotThrow(() => validatePaymentRequirements({
        network: SVM,
        asset: 'MINT',
        amount: '10000',
        payTo: 'seller',
        extra: {
            feePayer: '9BDf…',
            decimals: 6,
            tokenProgram: 'spl-token'
        }
    }));
});

test('rejects missing core fields', () => {
    for (const field of ['network', 'asset', 'amount', 'payTo']) {
        const req = {
            network: EVM,
            asset: 'A',
            amount: '1',
            payTo: 'p'
        };
        delete req[field];
        assert.throws(() => validatePaymentRequirements(req), new RegExp(`\`${field}\` is required`));
    }
});

test('rejects SVM missing extra.feePayer (the opaque server unexpected_error, caught locally)', () => {
    assert.throws(
        () => validatePaymentRequirements({
            network: SVM,
            asset: 'MINT',
            amount: '10000',
            payTo: 'seller',
            extra: { decimals: 6 }
        }),
        /SVM .* requires `extra.feePayer`/
    );
});

test('rejects SVM missing extra.decimals', () => {
    assert.throws(
        () => validatePaymentRequirements({
            network: SVM,
            asset: 'MINT',
            amount: '10000',
            payTo: 'seller',
            extra: { feePayer: '9BDf…' }
        }),
        /SVM .* requires `extra.decimals`/
    );
});
