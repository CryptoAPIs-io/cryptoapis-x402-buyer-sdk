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
         * @param {(string|Object)} [params.resource] the resource being paid for — the URL the
         *   client requested (or a v2 `{url}` ResourceInfo). x402 v2 carries NO resource inside
         *   PaymentRequirements, so without it the service cannot check the wallet's
         *   `allowedDomains` and refuses `domain_not_allowed`.
         * @return {Promise<{scheme: string, signing: Object}>} the wire scheme + signing artifact
         * @throws {Error} on a non-2xx (transport/auth) response, or when the service refuses the
         *   payment (`{authorized:false}` — budget, allowlist, wallet); the refusal carries
         *   `code: 'authorize_refused'` and the service's `reason`
         */
        async authorize({ paymentRequirements, walletId, resource }) {
            const res = await doFetch(`${root}/authorize`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                },
                body: JSON.stringify({
                    paymentRequirements: paymentRequirements,
                    walletId: walletId,
                    ...(resource ? { resource: resource } : {}),
                }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`buyer /authorize failed: ${res.status} ${text}`.trim());
            }
            const body = await res.json();
            // A policy refusal is a 200 `{authorized:false, reason}`, not a non-2xx. Surface it
            // as-is: carrying on would hand the signer an undefined scheme and bury the real
            // reason under a misleading "family not supported" error.
            if (body?.authorized === false) {
                const refusal = new Error(`buyer /authorize refused: ${body.reason ?? 'unknown'}`);
                refusal.code = 'authorize_refused';
                refusal.reason = body.reason;
                throw refusal;
            }
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
