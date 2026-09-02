/**
 * Turn a signed x402 authorization into the `PaymentPayload` + the base64 credential
 * header the buyer resubmits to the merchant.
 *
 * The PaymentPayload wire shape we emit:
 *   { x402Version, scheme, network, accepted: {…}, payload: <family-specific> }
 *
 * x402 v2 (§5.2.2) makes `accepted` REQUIRED and carries scheme/network inside it; v1
 * merchants instead match on TOP-LEVEL `scheme`/`network`. We send both: `accepted` for a
 * spec-conformant merchant, and the flat fields so a merchant that never shipped a
 * normalizer still pairs the payment to the right requirement. Neither reader is
 * confused by the other's field, and the two can never disagree — see buildAccepted.
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
 * Decode a base64 `PAYMENT-REQUIRED` header into the PaymentRequired challenge.
 *
 * The v2 HTTP transport carries the challenge here and treats the body as a server
 * implementation concern — a merchant conforming to it may send NO body at all.
 *
 * @param {(string|undefined|null)} headerValue the raw header value
 * @return {(Object|null)} the decoded PaymentRequired object, or null if absent/malformed
 */
function decodePaymentRequired(headerValue) {
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
        return null;
    }
    try {
        return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Read a merchant's challenge from a 402, preferring the v2 `PAYMENT-REQUIRED` header
 * and falling back to the v1 body.
 *
 * The header wins because a v2 merchant's body is not required to carry the challenge at
 * all (and need not be JSON); the body keeps a v1 merchant payable.
 *
 * @param {Object} params inputs
 * @param {(string|undefined|null)} [params.headerValue] the raw `PAYMENT-REQUIRED` header
 * @param {(Object|null)} [params.body] the parsed 402 body, when it was JSON
 * @return {Array<Object>} the acceptable PaymentRequirements (may be empty)
 */
function readChallenge({ headerValue, body }) {
    const fromHeader = parse402(decodePaymentRequired(headerValue));
    return fromHeader.length > 0 ? fromHeader : parse402(body);
}

/**
 * Build the `accepted` echo: the requirement the buyer chose, per x402 v2 §5.2.2.
 *
 * A merchant uses it to pair the payment with what it offered, so it must be the
 * requirement as OFFERED — echo it back untouched rather than reconstructing it.
 *
 * @param {Object} requirements the chosen PaymentRequirements
 * @return {Object} the `accepted` object
 */
function buildAccepted(requirements) {
    return { ...requirements };
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
 * @param {Object} [params.requirements] the chosen PaymentRequirements, echoed as `accepted` (v2 §5.2.2)
 * @return {{x402Version: number, scheme: string, network: string, payload: {signature: string, authorization: Object}}} the PaymentPayload
 */
function buildEip712Payload({ network, authorization, signature, requirements }) {
    return {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network: network,
        ...(requirements ? { accepted: buildAccepted(requirements) } : {}),
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
 * @param {Object} [params.requirements] the chosen PaymentRequirements, echoed as `accepted` (v2 §5.2.2)
 * @return {{x402Version: number, scheme: string, network: string, payload: {transaction: *}}} the PaymentPayload
 */
function buildTransactionPayload({ network, transaction, requirements }) {
    return {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network: network,
        ...(requirements ? { accepted: buildAccepted(requirements) } : {}),
        payload: {
            transaction: transaction,
        },
    };
}

/**
 * Encode a PaymentPayload as the base64 credential header value (sent on both
 * `PAYMENT-SIGNATURE` and `X-PAYMENT`).
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
    decodePaymentRequired,
    readChallenge,
    buildAccepted,
    buildEip712Payload,
    buildTransactionPayload,
    encodePaymentHeader,
    X402_VERSION,
    SCHEME_EXACT,
};
