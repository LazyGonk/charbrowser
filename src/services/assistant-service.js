import { callLlmChatWithMessages } from './llm-service.js';
import { loadSettings, resolveLlmProvider } from './settings-service.js';

const MAX_ASSISTANT_MESSAGES = 40;

/** @typedef {{role: 'system'|'user'|'assistant', content: string}} AssistantMessage */

/** @type {AssistantMessage[]} */
let conversationHistory = [];

/**
 * Returns true when current LLM settings can serve assistant chat requests.
 * Architectural context: keeps assistant configuration checks centralized in one service.
 * @returns {boolean}
 */
export function isAssistantConfigured() {
    const settings = loadSettings();
    return Boolean(String(settings?.llmEndpoint || '').trim() && String(settings?.llmModel || '').trim());
}

/**
 * Returns one compact label for the currently configured assistant model.
 * @returns {string}
 */
export function getAssistantModelLabel() {
    const settings = loadSettings();
    const model = String(settings?.llmModel || '').trim();
    return model || 'not configured';
}

/**
 * Returns a read-only copy of current assistant conversation history.
 * @returns {AssistantMessage[]}
 */
export function getAssistantHistory() {
    return conversationHistory.map((item) => ({ ...item }));
}

/**
 * Clears all assistant chat history for current app session.
 * Architectural context: session-only memory without disk persistence by design.
 */
export function clearAssistantHistory() {
    conversationHistory = [];
}

/**
 * Appends one assistant message and trims history to keep context bounded.
 * @param {AssistantMessage} message
 */
function pushMessage(message) {
    conversationHistory.push(message);

    const overflow = conversationHistory.length - MAX_ASSISTANT_MESSAGES;
    if (overflow > 0) {
        conversationHistory.splice(0, overflow);
    }
}

/**
 * Sends one user message to configured LLM using full conversation history.
 * @param {string} userText
 * @returns {Promise<string>}
 */
export async function sendAssistantMessage(userText) {
    const text = String(userText || '').trim();
    if (!text) {
        throw new Error('Message is empty.');
    }

    const settings = loadSettings();
    const endpoint = String(settings?.llmEndpoint || '').trim();
    const model = String(settings?.llmModel || '').trim();

    if (!endpoint || !model) {
        throw new Error('Configure LLM endpoint and model in Settings first.');
    }

    pushMessage({ role: 'user', content: text });

    const assistantText = await callLlmChatWithMessages({
        endpoint,
        apiKey: settings?.llmApiKey || '',
        apiType: resolveLlmProvider(settings),
        model,
        messages: conversationHistory,
        temperature: Number.isFinite(settings?.llmTemperature) ? settings.llmTemperature : 0.7,
        maxTokens: Number.isFinite(settings?.llmMaxTokens) ? settings.llmMaxTokens : 1024,
        systemPrompt: String(settings?.llmSystemPrompt || '').trim(),
    });

    pushMessage({ role: 'assistant', content: assistantText });
    return assistantText;
}
