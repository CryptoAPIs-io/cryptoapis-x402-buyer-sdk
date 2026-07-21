/**
 * HTTP client to the CryptoAPIs x402 BUYER service (`ai.cryptoapis.io/x402/buyer/*`).
 *
 * The buyer service's `/authorize` takes a merchant's PaymentRequirements + the
 * target agent wallet and returns the family-specific **signing artifact** the client
 * signs LOCALLY (`{ scheme, signing }`). This service NEVER signs — non-custodial.
 * Requires the buyer's CryptoAPIs `x-api-key` (X402_BUYER feature).
 */

/** The production buyer base URL. @type {string} */
const DEFAULT_BASE_URL = 'https://ai.cryptoapis.io/x402/buyer';

/**
 * Create a buyer-service client bound to an API key.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the buyer's CryptoAPIs API key (X402_BUYER feature)
 * @param {string} [params.baseUrl] override the buyer base URL (QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (injectable for tests)
 * @return {{authorize: Function}} the client
 */
function createAuthorizeClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl } = {}) {
    if (!apiKey) {
        throw new Error('createAuthorizeClient: apiKey is required');
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    const root = baseUrl.replace(/\/$/, '');

    return {
        /**
         * Get the signing artifact for a payment against a wallet.
         *
         * @param {Object} params inputs
         * @param {Object} params.paymentRequirements the merchant's PaymentRequirements (from the 402)
         * @param {string} params.walletId the agent wallet id to pay from
         * @return {Promise<{scheme: string, signing: Object}>} the wire scheme + signing artifact
         * @throws {Error} on a non-2xx (transport/auth/budget) response
         */
        async authorize({ paymentRequirements, walletId }) {
            const res = await doFetch(`${root}/authorize`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                },
                body: JSON.stringify({
                    paymentRequirements: paymentRequirements,
                    walletId: walletId
                }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`buyer /authorize failed: ${res.status} ${text}`.trim());
            }
            const body = await res.json();
            // The buyer service returns the artifact-to-sign as `signingPayload`; expose it to the
            // rest of the SDK under the internal `signing` name (older builds used `signing`, so we
            // accept either for forward/backward resilience). See buyer authorizeService.
            return {
                ...body,
                signing: body.signingPayload ?? body.signing,
            };
        },
    };
}

export {
    createAuthorizeClient, DEFAULT_BASE_URL
};
