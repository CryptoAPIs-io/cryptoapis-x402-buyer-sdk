/**
 * Turn a signed x402 authorization into the `PaymentPayload` + the base64 `X-PAYMENT`
 * header the buyer resubmits to the merchant.
 *
 * The PaymentPayload wire shape (from `@cryptoapis/x402-core`):
 *   { x402Version, scheme, network, payload: <family-specific> }
 * For EVM (`eip712`) the family payload is `{ signature, authorization }`; other
 * families carry their signed tx/blob (added as those buyer paths are wired here).
 */

/** x402 protocol version. @type {number} */
const X402_VERSION = 2;

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
        scheme: 'eip712',
        network: network,
        payload: {
            signature: signature,
            authorization: authorization,
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
    parse402,
    buildEip712Payload,
    encodePaymentHeader,
    X402_VERSION,
};
