// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Import required packages
import { config } from 'dotenv';
import * as path from 'path';
import * as restify from 'restify';

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
import { ActivityTypes, ConfigurationServiceClientCredentialFactory, MemoryStorage, TurnContext } from 'botbuilder';

import {
    ActionPlanner,
    ApplicationBuilder,
    LlamaModel,
    PromptManager,
    TeamsAdapter,
    TurnState
} from '@microsoft/teams-ai';
import { LlamaModelLocal } from "./oLlamaModel";
import * as responses from './responses';

// Read botFilePath and botFileSecret from .env file.
const ENV_FILE = path.join(__dirname, '..', '.env');
config({ path: ENV_FILE });

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about how bots work.
const adapter = new TeamsAdapter(
    {},
    new ConfigurationServiceClientCredentialFactory({
        MicrosoftAppId: process.env.BOT_ID,
        MicrosoftAppPassword: process.env.BOT_PASSWORD,
        MicrosoftAppType: 'MultiTenant'
    })
);

// Catch-all for errors.
const onTurnErrorHandler = async (context: TurnContext, error: any) => {
    // This check writes out errors to console log .vs. app insights.
    // NOTE: In production environment, you should consider logging this to Azure
    //       application insights.
    console.error(`\n [onTurnError] unhandled error: ${error}`);
    console.log(error);

    // Send a trace activity, which will be displayed in Bot Framework Emulator
    await context.sendTraceActivity(
        'OnTurnError Trace',
        `${error}`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
    );

    // Send a message to the user
    await context.sendActivity('The bot encountered an error or bug.');
    await context.sendActivity('To continue to run this bot, please fix the bot source code.');
};

// Set the onTurnError for the singleton CloudAdapter.
adapter.onTurnError = onTurnErrorHandler;

// Create HTTP server.
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

server.listen(process.env.port || process.env.PORT || 3978, () => {
    console.log(`\n${server.name} listening to ${server.url}`);
    console.log('\nGet Bot Framework Emulator: https://aka.ms/botframework-emulator');
    console.log('\nTo test your bot in Teams, sideload the app manifest.json within Teams Apps.');
});

// Strongly type the applications turn state
interface ConversationState {
    secretWord: string;
    guessCount: number;
    remainingGuesses: number;
}
type ApplicationTurnState = TurnState<ConversationState>;

if (!process.env.LLAMA_API_KEY && !process.env.LLAMA_ENDPOINT) {
    throw new Error('Missing environment variables - please check that LLAMA_API_KEY and LLAMA_ENDPOINT are set.');
}
// Create AI components
const model = new LlamaModelLocal({
    // Llama Support
    apiKey: process.env.LLAMA_API_KEY!,
    endpoint: process.env.LLAMA_ENDPOINT!,
    logRequests: true
});

const prompts = new PromptManager({
    promptsFolder: path.join(__dirname, 'prompts')
});

const planner = new ActionPlanner({
    model,
    prompts,
    defaultPrompt: 'default'
});
// Define storage and application
// - Note that we're not passing a prompt for our AI options as we won't be chatting with the app.
const storage = new MemoryStorage();
const app = new ApplicationBuilder<ApplicationTurnState>().withStorage(storage).build();

// List for /reset command and then delete the conversation state
app.message('/quit', async (context: TurnContext, state: ApplicationTurnState) => {
    const { secretWord } = state.conversation;
    state.deleteConversationState();
    await context.sendActivity(responses.quitGame(secretWord));
});

app.activity(ActivityTypes.Message, async (context: TurnContext, state: ApplicationTurnState) => {
    let { secretWord, guessCount, remainingGuesses } = state.conversation;
    if (secretWord && secretWord.length < 1) {
        throw new Error('No secret word is assigned.');
    }
    if (secretWord) {
        guessCount++;
        remainingGuesses--;

        // Check for correct guess
        if (context.activity.text.toLowerCase().indexOf(secretWord.toLowerCase()) >= 0) {
            await context.sendActivity(responses.youWin(secretWord));
            secretWord = '';
            guessCount = remainingGuesses = 0;
        } else if (remainingGuesses == 0) {
            await context.sendActivity(responses.youLose(secretWord));
            secretWord = '';
            guessCount = remainingGuesses = 0;
        } else {
            // Ask GPT for a hint
            const response = await getHint(context, state);
            if (response.toLowerCase().indexOf(secretWord.toLowerCase()) >= 0) {
                await context.sendActivity(`[${guessCount}] ${responses.blockSecretWord()}`);
            } else if (remainingGuesses == 1) {
                await context.sendActivity(`[${guessCount}] ${responses.lastGuess(response)}`);
            } else {
                await context.sendActivity(`[${guessCount}] ${response}`);
            }
        }
    } else {
        // Start new game
        secretWord = responses.pickSecretWord();
        guessCount = 0;
        remainingGuesses = 20;
        await context.sendActivity(responses.startGame());
    }

    // Save game state
    state.conversation.secretWord = secretWord;
    state.conversation.guessCount = guessCount;
    state.conversation.remainingGuesses = remainingGuesses;
});

// Listen for incoming server requests.
server.post('/api/messages', async (req, res) => {
    // Route received a request to adapter for processing
    await adapter.process(req, res as any, async (context) => {
        // Dispatch to application for routing
        await app.run(context);
    });
});

/**
 * Generates a hint for the user based on their input.
 * @param {TurnContext} context The current turn context.
 * @param {ApplicationTurnState} state The current turn state.
 * @returns {Promise<string>} A promise that resolves to a string containing the generated hint.
 * @throws {Error} If the request to LLM was rate limited.
 */
async function getHint(context: TurnContext, state: ApplicationTurnState): Promise<string> {
    state.temp.input = context.activity.text;
    const result = await planner.completePrompt(context, state, 'hint');

    if (result.status !== 'success') {
        throw result.error!;
    }

    return result.message!.content!;
}
