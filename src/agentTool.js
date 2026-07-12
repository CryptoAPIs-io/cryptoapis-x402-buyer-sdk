/**
 * The framework-NEUTRAL agent tool: a single `x402_pay` capability an AI agent can
 * call to fetch a (possibly paywalled) URL, auto-paying an HTTP 402 with x402.
 *
 * This is the shared core the framework adapters (LangChain, Vercel AI SDK,
 * OpenAI/function-calling, MCP) wrap — it has **zero framework dependencies**. Each
 * adapter maps the JSON-Schema `parameters` + `execute` here into that framework's
 * tool shape.
 *
 * Non-custodial: you pass a `signer` (see `createX402Fetch`); keys never enter the SDK.
 */

import { createX402Fetch } from './x402Fetch.js';

/** The tool's JSON Schema (portable — LangChain/AI-SDK/OpenAI all accept this shape). */
const X402_PAY_PARAMETERS = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: 'The URL to fetch. If it responds 402 Payment Required, it is paid automatically.'
        },
        method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method (default GET)'
        },
        body: {
            type: 'string',
            description: 'Optional request body (string)'
        },
    },
    required: ['url'],
    additionalProperties: false,
};

const X402_PAY_DESCRIPTION =
    'Fetch an HTTP resource, automatically paying with x402 if it returns 402 Payment Required. ' +
    'Use this whenever an API/URL requires a micropayment to access. Returns the response status and body ' +
    '(and payment settlement info when a payment was made). Payments are signed locally and non-custodially.';

/**
 * Build the framework-neutral x402_pay tool bound to a buyer wallet + signer.
 *
 * @param {Object} config the createX402Fetch config ({apiKey, walletId, signer, allowedNetworks?, baseUrl?})
 * @return {{name: string, description: string, parameters: Object, execute: Function}} the neutral tool
 */
function createPayTool(config) {
    const fetch402 = createX402Fetch(config);

    /**
     * Execute one paid fetch.
     *
     * @param {{url: string, method?: string, body?: string}} args the call args
     * @return {Promise<{status: number, paid: boolean, body: string, settlement?: Object}>} the result
     */
    async function execute({ url, method, body }) {
        const init = {
            method: method ?? 'GET',
            ...(body != null ? { body } : {})
        };
        const res = await fetch402(url, init);
        const settlementHeader = res.headers?.get?.('x-payment-response');
        return {
            status: res.status,
            paid: Boolean(settlementHeader),
            body: await res.text(),
            ...(settlementHeader
                ? { settlement: JSON.parse(Buffer.from(settlementHeader, 'base64').toString('utf8')) }
                : {}),
        };
    }

    return {
        name: 'x402_pay',
        description: X402_PAY_DESCRIPTION,
        parameters: X402_PAY_PARAMETERS,
        execute: execute,
    };
}

export {
    createPayTool, X402_PAY_PARAMETERS, X402_PAY_DESCRIPTION
};
