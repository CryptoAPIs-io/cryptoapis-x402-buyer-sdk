/**
 * Client-side PaymentRequirements validation — catch a malformed merchant 402 BEFORE
 * the `/authorize` round-trip, so a missing field surfaces as a clear local error
 * instead of an opaque server response.
 *
 * The family is derived from the CAIP-2 `network` prefix (evm=`eip155:`, svm=`solana:`,
 * …). SVM in particular needs `extra.feePayer` (+ `decimals`) — omitting it used to only
 * surface as the buyer service's `unexpected_error`; now it throws here first.
 */

/**
 * Resolve the x402 family from a CAIP-2 network id.
 *
 * @param {string} network the CAIP-2 network id
 * @return {(string|null)} the family (`evm`/`svm`/`tron`/`utxo`/`xrp`/`kaspa`) or null
 */
function familyOf(network) {
    if (typeof network !== 'string') {
        return null;
    }
    if (network.startsWith('eip155:')) {
        return 'evm';
    }
    if (network.startsWith('solana:')) {
        return 'svm';
    }
    if (network.startsWith('tron:')) {
        return 'tron';
    }
    if (network.startsWith('bip122:')) {
        return 'utxo';
    }
    if (network.startsWith('xrpl:')) {
        return 'xrp';
    }
    if (network.startsWith('kaspa:')) {
        return 'kaspa';
    }
    return null;
}

/**
 * Validate a merchant's PaymentRequirements for the fields the buyer `/authorize` needs,
 * per family. Throws a clear error naming the missing/invalid field. Does NOT enforce
 * business policy (budget/allowlist) — only the shape the authorize step requires.
 *
 * @param {Object} requirements the merchant PaymentRequirements (one `accepts[]` entry)
 * @return {void}
 * @throws {Error} `invalid_payment_requirements` when a required field is missing/invalid
 */
function validatePaymentRequirements(requirements) {
    const r = requirements ?? {};
    for (const field of ['network', 'asset', 'amount', 'payTo']) {
        if (r[field] === undefined || r[field] === null || r[field] === '') {
            throw new Error(`invalid_payment_requirements: \`${field}\` is required`);
        }
    }
    const family = familyOf(r.network);
    if (family === 'svm') {
        const extra = r.extra ?? {};
        if (typeof extra.feePayer !== 'string' || extra.feePayer.length === 0) {
            throw new Error(
                'invalid_payment_requirements: SVM (Solana) requires `extra.feePayer` — the ' +
                'facilitator fee-payer pubkey (from GET /x402/merchant/supported `signers`)'
            );
        }
        if (extra.decimals === undefined || extra.decimals === null) {
            throw new Error(
                'invalid_payment_requirements: SVM (Solana) requires `extra.decimals` ' +
                '(e.g. 6 for USDC) — a wrong/absent value builds a wrong-decimals transfer'
            );
        }
    }
}

export {
    validatePaymentRequirements, familyOf
};
