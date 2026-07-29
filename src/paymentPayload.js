/**
 * Turn a signed x402 authorization into the `PaymentPayload` + the base64 `X-PAYMENT`
 * header the buyer resubmits to the merchant.
 *
 * The PaymentPayload wire shape (what the facilitator's `parseEnvelope` accepts):
 *   { x402Version, scheme, network, payload: <family-specific> }
 *
 * **CRITICAL:** `paymentPayload.scheme` is ALWAYS `'exact'` (the PAYMENT scheme —
 * `parseEnvelope` rejects anything else). It is NOT the buyer `/authorize` artifact
 * scheme (`eip712`/`svm-transaction`/…): that only tells the client HOW to sign. The
 * FAMILY is carried by `network` (`familyOf(network)`), and requirements↔payload are
 * paired by `network`, not by scheme. For EVM the family payload is
 * `{ signature, authorization }`; other families carry `{ transaction: <signed> }`.
 */

/** x402 protocol version. @type {number} */
const X402_VERSION = 2;

/** The PAYMENT scheme — always `exact` on the wire (the family is in `network`). @type {string} */
const SCHEME_EXACT = 'exact';

/**
 * Parse a merchant's HTTP 402 body into its `accepts` list.
 *
 * @param {Object} body the 402 response body `{ x402Version, accepts, error? }`
 * @return {Array<Object>} the acceptable PaymentRequirements (may be empty)
 */
function parse402(body) {
    if (!body || !Array.isArray(body.accepts)) {
        return [];
    }
    return body.accepts;
}

/**
 * Attach the `payment-identifier` extension to a PaymentPayload.
 *
 * The id becomes the facilitator's idempotency key, so the CALLER controls dedup: a retry
 * of a request whose response never arrived settles once, not twice. Without an id the
 * facilitator falls back to the authorization nonce — correct, but not caller-addressable.
 *
 * The spec bounds the id to 16-128 characters; an out-of-bounds value is dropped here
 * rather than sent, since the facilitator would ignore it anyway and a silently-ignored
 * idempotency key is worse than an obviously absent one.
 *
 * @param {Object} payload a PaymentPayload
 * @param {string} [paymentId] the caller's idempotency id
 * @return {Object} the payload, with the extension when the id is usable
 */
function withPaymentIdentifier(payload, paymentId) {
    if (typeof paymentId !== 'string' || paymentId.length < 16 || paymentId.length > 128) {
        return payload;
    }
    return {
        ...payload,
        extensions: {
            ...(payload.extensions ?? {}),
            'payment-identifier': { info: { id: paymentId } },
        },
    };
}

/**
 *
 * @param param
 * @param param.network
 * @param param.authorization
 * @param param.signature
 */
/**
 * Build the EVM (`eip712`) PaymentPayload from the signed EIP-3009 authorization.
 *
 * @param {Object} params inputs
 * @param {string} params.network CAIP-2 network id
 * @param {Object} params.authorization the EIP-3009 message that was signed (from/to/value/validAfter/validBefore/nonce)
 * @param {string} params.signature the 65-byte EIP-712 signature (0x…)
 * @return {{x402Version: number, scheme: string, network: string, payload: {signature: string, authorization: Object}}} the PaymentPayload
 */
function buildEip712Payload({ network, authorization, signature }) {
    return {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network: network,
        payload: {
            signature: signature,
            authorization: authorization,
        },
    };
}

/**
 * Build a transaction-carrying PaymentPayload — the shape every NON-EVM family uses
 * (SVM/Tron/UTXO/Kaspa/XRP). Each family's `parsePayload` reads `payload.transaction`
 * (the signed tx: base64 for SVM, signed-object for Tron, raw hex for UTXO, JSON for
 * Kaspa, tx_blob for XRP). The signer produced this `transaction`; we only wrap it.
 *
 * `scheme` is `'exact'` (NOT the family) and the family comes from `network` — same
 * rule as the EVM payload; the facilitator's `parseEnvelope` requires it.
 *
 * @param {Object} params inputs
 * @param {string} params.network the CAIP-2 network id (carries the family via familyOf)
 * @param {*} params.transaction the signed transaction (string or object, per family)
 * @return {{x402Version: number, scheme: string, network: string, payload: {transaction: *}}} the PaymentPayload
 */
function buildTransactionPayload({ network, transaction }) {
    return {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network: network,
        payload: {
            transaction: transaction,
        },
    };
}

/**
 * Encode a PaymentPayload as the base64 `X-PAYMENT` header value.
 *
 * @param {Object} paymentPayload the PaymentPayload
 * @return {string} the base64 header value
 */
function encodePaymentHeader(paymentPayload) {
    return Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64');
}

export {
    withPaymentIdentifier,
    parse402,
    buildEip712Payload,
    buildTransactionPayload,
    encodePaymentHeader,
    X402_VERSION,
    SCHEME_EXACT,
};
