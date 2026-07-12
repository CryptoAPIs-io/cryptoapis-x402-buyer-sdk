/**
 * Framework-neutral function-calling adapter — for OpenAI, Anthropic, Gemini, or any
 * model that takes a JSON tool schema + you run the tool loop yourself. Zero deps.
 *
 *   import { x402PayFunction } from '@cryptoapis-io/x402-buyer-sdk/function-calling';
 *
 *   const pay = x402PayFunction({ apiKey, walletId, signer });
 *   // OpenAI: tools: [pay.openaiTool]   (or pay.anthropicTool / pay.geminiTool)
 *   // when the model calls it: const result = await pay.run(JSON.parse(toolCall.arguments));
 */

import { createPayTool } from './agentTool.js';

/**
 * Build a function-calling tool (schema in several vendor shapes + a runner).
 *
 * @param {Object} config the createX402Fetch config ({apiKey, walletId, signer, ...})
 * @return {{name: string, description: string, parameters: Object, openaiTool: Object, anthropicTool: Object, geminiTool: Object, run: Function}} the tool
 */
function x402PayFunction(config) {
    const t = createPayTool(config);
    return {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        // OpenAI Chat Completions / Assistants shape.
        openaiTool: {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            },
        },
        // Anthropic Messages `tools` shape (input_schema is Anthropic's field name).
        anthropicTool: {
            name: t.name,
            description: t.description,
            // eslint-disable-next-line camelcase
            input_schema: t.parameters,
        },
        // Google Gemini functionDeclarations shape.
        geminiTool: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
        /**
         * Run the tool with the model-provided arguments.
         *
         * @param {{url: string, method?: string, body?: string}} args the arguments
         * @return {Promise<Object>} the result to feed back to the model
         */
        run: (args) => t.execute(args),
    };
}

export { x402PayFunction };
