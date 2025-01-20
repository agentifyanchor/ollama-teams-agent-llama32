import { TurnContext } from 'botbuilder';
import { LlamaModel, LlamaModelOptions, Memory, Message, PromptCompletionModel, PromptFunctions, PromptTemplate, Tokenizer } from '@microsoft/teams-ai';
import { PromptResponse } from '@microsoft/teams-ai/lib/types';

// Define a decorator class to add custom functionality
export class LlamaModelLocal implements PromptCompletionModel {
    private llamaModel: LlamaModel;

    constructor(options: LlamaModelOptions) {
        // Create an instance of the LlamaModel as a composition (not inheritance)
        this.llamaModel = new LlamaModel(options);
    }

    // Override the completePrompt method to add custom behavior
    public async completePrompt(
        context: TurnContext,
        memory: Memory, // Adjusted to fit your app's state structure
        functions: PromptFunctions,
        tokenizer: Tokenizer,
        template: PromptTemplate
    ): Promise<PromptResponse<string>> {
        const max_input_tokens = template.config.completion.max_input_tokens;
        const result = await template.prompt.renderAsMessages(context, memory, functions, tokenizer, max_input_tokens);

        if (result.tooLong) {
            return {
                status: 'too_long',
                error: new Error('The generated prompt length was too long')
            };
        }

        // Extract the last user input message (if present)
        let last: Message | undefined = result.output[result.output.length - 1];
        if (last?.role !== 'user') {
            last = undefined;
        }

        // Add logging or other behavior as needed
        if (this.llamaModel.options.logRequests) {
            console.log("CHAT PROMPT:");
            console.log(result.output);
        }

        // Adjust the payload to fit the format expected by Ollama or other endpoints
        const adjustedPayload = {
            model: "llama3.2:latest", // Use the correct model identifier
            prompt: result.output.map(msg => msg.content).join(' '), // Flatten messages into a single prompt string
            max_tokens: template.config.completion.max_tokens || 50,
            temperature: template.config.completion.temperature || 0.7,
            //completion_type: "chat",
        };

        // Make the API request via the llamaModel instance
        let res;
        try {
            res = await this.llamaModel['_httpClient'].post(this.llamaModel.options.endpoint, adjustedPayload);
            if (this.llamaModel.options.logRequests) {
                console.log("CHAT RESPONSE:");
                console.log(res.data.choices);
            }
        } catch (error) {
            console.error("Error in API call:", error);
            throw error;
        }

        // Return the response in the expected format
        return {
            status: 'success',
            input: last,
            message: {
                role: 'assistant',
                content: res.data.choices[0].text.trim(),
            },
        };
    }
}
