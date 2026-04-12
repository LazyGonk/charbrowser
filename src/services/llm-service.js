import { invoke } from '@tauri-apps/api/core';

/**
 * Returns an endpoint without trailing slash for predictable URL joins.
 * @param {string} endpoint
 * @returns {string}
 */
function normalizeEndpoint(endpoint) {
    return String(endpoint || '').trim().replace(/\/+$/, '');
}

/**
 * Detects provider type from explicit setting or endpoint URL.
 * @param {string | undefined} apiType
 * @param {string} endpoint
 * @returns {'openai'|'openrouter'|'groq'|'deepseek'|'custom'|'ollama'}
 */
function resolveProvider(apiType, endpoint) {
    const normalizedApiType = String(apiType || '').trim().toLowerCase();
    if (normalizedApiType) {
        return /** @type {'openai'|'openrouter'|'groq'|'deepseek'|'custom'|'ollama'} */ (normalizedApiType);
    }

    const lower = String(endpoint || '').toLowerCase();
    if (lower.includes('localhost:11434') || lower.includes('ollama')) {
        return 'ollama';
    }
    if (lower.includes('openrouter.ai')) {
        return 'openrouter';
    }
    if (lower.includes('api.groq.com')) {
        return 'groq';
    }
    if (lower.includes('api.deepseek.com')) {
        return 'deepseek';
    }
    return 'openai';
}

/**
 * Returns true when one template variable should be treated as present.
 * @param {unknown} value
 * @returns {boolean}
 */
function hasTemplateValue(value) {
    if (value == null) {
        return false;
    }
    return String(value).trim().length > 0;
}

/**
 * Renders one prompt template with support for {{var}} and {{#if var}}...{{/if}} blocks.
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {string}
 */
function renderPromptTemplate(template, variables) {
    const base = String(template || '');

    const withConditionals = base.replace(/{{#if\s+([a-zA-Z0-9_]+)}}([\s\S]*?){{\/if}}/g, (_all, key, inner) => {
        const variableValue = variables[key] || '';
        return hasTemplateValue(variableValue) ? inner : '';
    });

    return withConditionals
        .replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_all, key) => variables[key] || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Returns one field value from form data using the template key naming.
 * @param {string} key
 * @param {{name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[]}} formData
 * @returns {string}
 */
function readFieldValueFromFormData(key, formData) {
    if (key === 'first_mes') {
        return String(formData.firstMes || '');
    }
    if (key === 'creator_notes') {
        return String(formData.creatorNotes || '');
    }
    if (key === 'tags') {
        return Array.isArray(formData.tags) ? formData.tags.join(', ') : '';
    }
    return String(formData[key] || '');
}

/**
 * Builds one template-variable payload from current form values.
 * @param {{
 *   targetField: string,
 *   formData: {name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[]},
 *   userInputOverride?: string,
 * }} options
 * @returns {Record<string, string>}
 */
function buildTemplateVariables(options) {
    const targetValue = readFieldValueFromFormData(options.targetField, options.formData);

    return {
        name: String(options.formData.name || ''),
        description: String(options.formData.description || ''),
        first_mes: String(options.formData.firstMes || ''),
        creator_notes: String(options.formData.creatorNotes || ''),
        scenario: String(options.formData.scenario || ''),
        tags: Array.isArray(options.formData.tags) ? options.formData.tags.join(', ') : '',
        userInput: String(options.userInputOverride ?? targetValue ?? ''),
        char: '{{char}}',
        user: '{{user}}',
    };
}

/**
 * Returns true when the field should be included in contextual generation input.
 * @param {string} targetField
 * @param {string} candidateField
 * @param {string} value
 * @returns {boolean}
 */
function shouldIncludeFieldInPrompt(targetField, candidateField, value) {
    if (!value || !value.trim()) {
        return false;
    }
    return targetField !== candidateField;
}

/**
 * Builds contextual field payload for generation prompts.
 * @param {string} targetField
 * @param {{name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[]}} formData
 * @returns {Record<string, string>}
 */
function buildGenerationContext(targetField, formData) {
    const values = {
        name: formData.name || '',
        description: formData.description || '',
        first_mes: formData.firstMes || '',
        creator_notes: formData.creatorNotes || '',
        scenario: formData.scenario || '',
        tags: Array.isArray(formData.tags) ? formData.tags.join(', ') : '',
    };

    const context = {};
    for (const [field, value] of Object.entries(values)) {
        if (shouldIncludeFieldInPrompt(targetField, field, value)) {
            context[field] = value;
        }
    }

    return context;
}

/**
 * Escapes one string for safe usage in a RegExp pattern.
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Forces canonical roleplay placeholders for fields that should avoid literal names.
 * @param {string} targetField
 * @param {string} text
 * @param {{name: string}} formData
 * @returns {string}
 */
function normalizeRoleplayPlaceholders(targetField, text, formData) {
    if (targetField !== 'first_mes' && targetField !== 'scenario') {
        return text;
    }

    let output = text
        .replace(/{{\s*char\s*}}/gi, '{{char}}')
        .replace(/{{\s*user\s*}}/gi, '{{user}}');

    const characterName = String(formData?.name || '').trim();
    if (characterName) {
        const pattern = new RegExp(`\\b${escapeRegex(characterName)}\\b`, 'gi');
        output = output.replace(pattern, '{{char}}');
    }

    return output;
}

/**
 * Builds one user prompt either from editable template or prefix/context fallback.
 * @param {{
 *   targetField: string,
 *   fieldPromptPrefix?: string,
 *   fieldPromptTemplate?: string,
 *   userInputOverride?: string,
 *   previousResponses?: string[],
 *   formData: {name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[]}
 * }} options
 * @returns {string}
 */
function buildUserPrompt(options) {
    if (options.fieldPromptTemplate && options.fieldPromptTemplate.trim()) {
        const templateVariables = buildTemplateVariables(options);
        const rendered = renderPromptTemplate(options.fieldPromptTemplate, templateVariables);

        if (Array.isArray(options.previousResponses) && options.previousResponses.length > 0) {
            const attempts = options.previousResponses
                .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
                .map((entry, index) => `${index + 1}. ${entry}`)
                .join('\n');

            return `${rendered}\n\nPrevious generated attempts (avoid repeating these verbatim):\n${attempts}`;
        }

        return rendered;
    }

    const context = buildGenerationContext(options.targetField, options.formData);
    const existingValue = String(
        options.userInputOverride
            ?? (options.targetField === 'first_mes'
                ? options.formData.firstMes
                : options.targetField === 'creator_notes'
                    ? options.formData.creatorNotes
                    : options.targetField === 'tags'
                        ? (options.formData.tags || []).join(', ')
                        : options.formData[options.targetField] || '')
    );

    const parts = [
        options.fieldPromptPrefix || 'Generate suitable text for this character-card field.',
        `Target field: ${options.targetField}`,
    ];

    if (existingValue.trim()) {
        parts.push(`Current ${options.targetField} value:\n${existingValue}`);
    }

    if (Object.keys(context).length > 0) {
        parts.push(`Known field context:\n${JSON.stringify(context, null, 2)}`);
    }

    if (Array.isArray(options.previousResponses) && options.previousResponses.length > 0) {
        parts.push(`Previous generated attempts (avoid repeating these verbatim):\n${options.previousResponses
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry, index) => `${index + 1}. ${entry}`)
            .join('\n')}`);
    }

    parts.push('Return only the generated value for the target field, without explanation.');
    return parts.join('\n\n');
}

/**
 * Fetches available model IDs from an OpenAI-compatible endpoint via Tauri backend.
 * Falls back to direct fetch if Tauri invoke fails.
 * @param {{endpoint: string, apiKey?: string}} options
 * @returns {Promise<string[]>}
 */
export async function fetchAvailableModels(options) {
    const endpoint = normalizeEndpoint(options?.endpoint || '');
    if (!endpoint) {
        return [];
    }

    const provider = resolveProvider(options?.apiType, endpoint);

    // Try Tauri backend first
    try {
        const models = await invoke('get_llm_models', {
            endpoint,
            apiKey: options?.apiKey || null,
            apiType: provider,
        });
        return models;
    } catch (error) {
        // Fallback to direct fetch (for dev mode)
        try {
            const modelsEndpoint = provider === 'ollama'
                ? `${endpoint}/api/tags`
                : (endpoint.endsWith('/v1') ? `${endpoint}/models` : `${endpoint}/v1/models`);
            
            const response = await fetch(modelsEndpoint, {
                method: 'GET',
                headers: {
                    ...(options?.apiKey
                        ? { Authorization: `Bearer ${options.apiKey}` }
                        : {}),
                    ...(provider === 'openrouter'
                        ? {
                            'HTTP-Referer': 'https://charbrowser.app',
                            'X-Title': 'CharBrowser',
                        }
                        : {}),
                },
            });
            
            if (!response.ok) {
                throw new Error(`Model list request failed (${response.status})`);
            }
            
            const payload = await response.json();
            if (provider === 'ollama') {
                const models = Array.isArray(payload?.models) ? payload.models : [];
                return models.map(item => item?.name || '').filter(Boolean);
            }

            const data = Array.isArray(payload?.data) ? payload.data : [];
            return data.map((item) => item.id || '').filter(Boolean);
        } catch (fetchError) {
            throw new Error(`Model list request failed: ${fetchError}`);
        }
    }
}

/**
 * Sends one OpenAI-compatible generation request for a specific card field.
 * @param {{
 *   endpoint: string,
 *   apiKey: string,
 *   model: string,
 *   temperature: number,
 *   maxTokens: number,
 *   systemPrompt: string,
 *   targetField: string,
 *   fieldPromptPrefix?: string,
 *   fieldPromptTemplate?: string,
 *   userInputOverride?: string,
 *   previousResponses?: string[],
 *   formData: {name: string, description: string, firstMes: string, creatorNotes: string, scenario: string, tags: string[]}
 * }} options
 * @returns {Promise<string>}
 */
export async function generateFieldWithOpenAiCompatible(options) {
    const endpoint = normalizeEndpoint(options.endpoint || '');
    const provider = resolveProvider(options.apiType, endpoint);
    if (!endpoint) {
        throw new Error('LLM endpoint is required.');
    }
    if (!options.model || !options.model.trim()) {
        throw new Error('LLM model is required.');
    }

    const messages = [
        {
            role: 'system',
            content: options.systemPrompt || 'You write concise, high-quality character card content.',
        },
        {
            role: 'user',
            content: buildUserPrompt({
                targetField: options.targetField,
                fieldPromptPrefix: options.fieldPromptPrefix,
                fieldPromptTemplate: options.fieldPromptTemplate,
                userInputOverride: options.userInputOverride,
                previousResponses: options.previousResponses,
                formData: options.formData,
            }),
        },
    ];

    try {
        const content = await invoke('call_llm_chat', {
            endpoint,
            apiKey: options.apiKey || null,
            apiType: provider,
            model: options.model.trim(),
            messages,
            temperature: Number.isFinite(options.temperature) ? options.temperature : 0.7,
            maxTokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 1024,
        });

        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('LLM returned an empty response.');
        }

        const normalizedContent = normalizeRoleplayPlaceholders(
            options.targetField,
            content.trim(),
            options.formData
        );

        return normalizedContent;
    } catch (error) {
        throw new Error(`LLM request failed: ${error}`);
    }
}

/**
 * Sends one OpenAI-compatible chat request using explicit message history.
 * Architectural context: shared low-level chat transport for assistant and generation flows.
 * @param {{
 *   endpoint: string,
 *   apiKey?: string,
 *   apiType?: string,
 *   model: string,
 *   messages: Array<{role: string, content: string}>,
 *   temperature?: number,
 *   maxTokens?: number,
 *   systemPrompt?: string,
 * }} options
 * @returns {Promise<string>}
 */
export async function callLlmChatWithMessages(options) {
    const endpoint = normalizeEndpoint(options?.endpoint || '');
    const provider = resolveProvider(options?.apiType, endpoint);
    const model = String(options?.model || '').trim();

    if (!endpoint) {
        throw new Error('LLM endpoint is required.');
    }
    if (!model) {
        throw new Error('LLM model is required.');
    }

    const sourceMessages = Array.isArray(options?.messages) ? options.messages : [];
    const normalizedMessages = sourceMessages
        .map((message) => ({
            role: String(message?.role || '').trim(),
            content: String(message?.content || '').trim(),
        }))
        .filter((message) => message.role.length > 0 && message.content.length > 0);

    if (normalizedMessages.length === 0) {
        throw new Error('At least one message is required.');
    }

    const systemPrompt = String(options?.systemPrompt || '').trim();
    const messages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...normalizedMessages]
        : normalizedMessages;

    try {
        const content = await invoke('call_llm_chat', {
            endpoint,
            apiKey: options?.apiKey || null,
            apiType: provider,
            model,
            messages,
            temperature: Number.isFinite(options?.temperature) ? options.temperature : 0.7,
            maxTokens: Number.isFinite(options?.maxTokens) ? options.maxTokens : 1024,
        });

        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('LLM returned an empty response.');
        }

        return content.trim();
    } catch (error) {
        throw new Error(`LLM request failed: ${error}`);
    }
}