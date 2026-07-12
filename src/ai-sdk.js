/**
 * Vercel AI SDK adapter — expose x402 payment as an AI SDK `tool`:
 *
 *   import { x402PayTool } from '@cryptoapis-io/x402-buyer-sdk/ai-sdk';
 *   import { generateText } from 'ai';
 *
 *   const result = await generateText({
 *     model,
 *     tools: { x402_pay: x402PayTool({ apiKey, walletId, signer }) },
 *     prompt: 'Fetch https://api.example.com/premium and summarize it.',
 *   });
 *
 * `ai` is a PEER dependency (the caller already has it); this file imports `tool` +
 * `jsonSchema` from it lazily so the buyer SDK stays zero-dep.
 */

import { createPayTool } from './agentTool.js';

/**
 * Build a Vercel AI SDK tool for x402 payment.
 *
 * @param {Object} config the createX402Fetch config ({apiKey, walletId, signer, ...})
 * @param {Object} [aiSdk] the `ai` module ({tool, jsonSchema}); auto-imported if omitted
 * @return {Promise<Object>|Object} the AI SDK tool (a Promise when auto-importing `ai`)
 */
function x402PayTool(config, aiSdk) {
    const t = createPayTool(config);
    const build = ({ tool, jsonSchema }) => tool({
        description: t.description,
        parameters: jsonSchema(t.parameters),
        execute: (args) => t.execute(args),
    });
    if (aiSdk) {
        return build(aiSdk);
    }
    // Lazy peer import so the SDK never bundles `ai`.
    return import('ai').then(build);
}

export { x402PayTool };
