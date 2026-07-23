/**
 * HTTP client for the CryptoAPIs x402 BUYER wallet registry
 * (`ai.cryptoapis.io/x402/buyer/wallets`).
 *
 * The x402 SDK pays from an **agent wallet** referenced by `walletId` — the buyer
 * service's own record `_id`, NOT the on-chain address. This client removes the need
 * to hand-roll `fetch` against `/wallets`: `createWallet` registers a wallet (returns
 * the `walletId` to pass to `createX402Fetch`) and `listWallets` reads them back.
 *
 * NON-CUSTODIAL: registration takes only your PUBLIC `address` (or an `xpub`); no
 * private key ever leaves your process.
 */

import { DEFAULT_BASE_URL } from './authorizeClient.js';

/**
 * Validate the create-wallet input the same way the buyer service does, so a bad call
 * throws a clear local error instead of a round-trip that returns `400 malformed_request`.
 *
 * @param {Object} input the createWallet input
 * @return {void}
 * @throws {Error} `malformed_wallet_request` when required fields are missing/ambiguous
 */
function assertCreateWalletInput(input) {
    const network = input?.network;
    if (typeof network !== 'string' || network.length === 0) {
        throw new Error(
            'createWallet: `network` (a CAIP-2 id, e.g. "eip155:8453" or ' +
            '"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") is required — not a bare name like "base"'
        );
    }
    const hasAddress = typeof input.address === 'string' && input.address.length > 0;
    const hasXpub = typeof input.xpub === 'string' && input.xpub.length > 0;
    if (hasAddress === hasXpub) {
        throw new Error(
            'createWallet: exactly one of `address` (bring your own; required for Solana/Kaspa) ' +
            'or `xpub` (xpub-capable chains) is required'
        );
    }
}

/**
 * Create a buyer-wallet registry client bound to an API key.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the buyer's CryptoAPIs API key (X402_BUYER feature)
 * @param {string} [params.baseUrl] override the buyer base URL (QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (injectable for tests / custom CA)
 * @return {{createWallet: Function, listWallets: Function}} the client
 */
function createWalletsClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl } = {}) {
    if (!apiKey) {
        throw new Error('createWalletsClient: apiKey is required');
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    const root = baseUrl.replace(/\/$/, '');

    return {
        /**
         * Register an agent wallet (once per blockchain+network) and return its `walletId`.
         *
         * @param {Object} input { blockchain?, network (CAIP-2 id), address | xpub, allowedNetworks?, allowedDomains?, limits? }
         *   `limits` = `{ perTxLimit?, dailyLimit?, monthlyLimit? }` (atomic-unit strings; omit/null = unlimited).
         *   **Only `perTxLimit` is enforced today**; `dailyLimit`/`monthlyLimit` are stored but NOT yet
         *   enforced (the response echoes `limitsNotEnforced: [...]` when set). Wallets are unlimited by default.
         * @return {Promise<{walletId: string, address: string, type: string, existing?: boolean, limitsNotEnforced?: Array<string>}>} the created (or existing) wallet
         * @throws {Error} locally on a malformed input, or on a non-2xx response
         */
        async createWallet(input) {
            assertCreateWalletInput(input);
            const res = await doFetch(`${root}/wallets`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                },
                body: JSON.stringify(input),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`buyer /wallets create failed: ${res.status} ${text}`.trim());
            }
            return res.json();
        },

        /**
         * List the API key's agent wallets (each with its `walletId`).
         *
         * @return {Promise<Array<{walletId: string, address: string, type: string, network?: string}>>} the wallets
         * @throws {Error} on a non-2xx response
         */
        async listWallets() {
            const res = await doFetch(`${root}/wallets`, {
                method: 'GET',
                headers: { 'x-api-key': apiKey },
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`buyer /wallets list failed: ${res.status} ${text}`.trim());
            }
            return res.json();
        },
    };
}

export {
    createWalletsClient, assertCreateWalletInput
};
