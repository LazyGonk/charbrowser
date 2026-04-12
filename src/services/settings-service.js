import { getAppDataPath, getAppSettings, saveAppSettings } from './tauri-api.js';

const LEGACY_DEFAULT_PROMPT_TEMPLATE_NAME = `Generate a suitable character name for a roleplaying character.

{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if name}}Current name to improve upon: {{name}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Output ONLY the name, no explanation.`;

/**
 * Default frontend settings used when no persisted settings exist.
 * These values are intentionally conservative and OpenAI-compatible by default.
 */
export const DEFAULT_SETTINGS = {
    darkMode: true,
    showHiddenFiles: false,
    autoLoadMetadata: true,
    showThumbnails: true,
    preserveThumbnails: true,
    autoSaveCards: false,
    backupInterval: 60,
    defaultCardFormat: '3.0',
    previewQuality: 'balanced',
    llmApiType: 'openai',
    llmApiEndpoint: 'custom',
    llmEndpoint: 'http://localhost:1234/v1',
    llmApiKey: '',
    llmModel: '',
    llmTemperature: 0.7,
    llmMaxTokens: 1024,
    llmSystemPrompt: 'You write concise, high-quality character card content.',
    promptTemplateName: `Generate a suitable NEW character name for a roleplaying character.

{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if name}}Current name to improve upon: {{name}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

If the description, first message, or input already mention a character name, do NOT repeat it and do NOT output "{{char}}".
Invent a fresh character name instead.

Output ONLY the name, no explanation.`,
    promptTemplateDescription: `Generate a detailed character description for a roleplaying character.

{{#if name}}Character name: {{name}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if description}}Current description to improve upon: {{description}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Generate a vivid, detailed description of this character's appearance, personality, and background. Reference the character as "{{char}}" and the user as "{{user}}".`,
    promptTemplateFirstMes: `Generate a first message (opening greeting) for a roleplaying character.

{{#if name}}Character name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if first_mes}}Current first message to improve upon: {{first_mes}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Write about 10 sentences describing how {{char}} meets {{user}} and greets {{user}}.
Do not use real names for either party. Always use the literal placeholders "{{char}}" and "{{user}}".`,
    promptTemplateCreatorNotes: `Generate creator notes for a character card.

{{#if name}}Name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}

{{#if creator_notes}}Current notes to improve upon: {{creator_notes}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Generate concise creator notes that capture character behavior and usage context.`,
    promptTemplateScenario: `Generate a scenario/context for a roleplaying character.

{{#if name}}Character name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if scenario}}Current scenario to improve upon: {{scenario}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Write a scenario setting that establishes where and how {{user}} and {{char}} meet/interact.
Do not use real names for either party. Always use the literal placeholders "{{char}}" and "{{user}}".`,
    promptTemplateTags: `Generate tags for a character card. Tags should be comma-separated keywords.

{{#if name}}Character name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}

{{#if tags}}Current tags to improve upon: {{tags}}{{/if}}
{{#if userInput}}Original user input: {{userInput}}{{/if}}

Generate 3-6 relevant tags. Output ONLY the tags, comma-separated, no explanation.`,
    promptTemplateVisualDesc: `Extract ONLY visual and scene-relevant details for image generation.

Inputs:
{{#if description}}Character Description: {{description}}{{/if}}
{{#if first_mes}}First Message: {{first_mes}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}

Focus on:
- physical appearance (face, hair, body, age cues)
- clothing, accessories, props
- pose, camera framing, expression
- environment/background and lighting cues
- art-style hints only when clearly implied

Exclude:
- personality traits not visually observable
- biography/lore, motivations, dialogue style
- relationships or roleplay instruction text

Write one concise but detailed image prompt paragraph.`,
    promptTemplateGenerateAll: `Generate all missing character card fields.

Current filled fields:
{{#if name}}name: {{name}}{{/if}}
{{#if description}}description: {{description}}{{/if}}
{{#if first_mes}}first_mes: {{first_mes}}{{/if}}
{{#if creator_notes}}creator_notes: {{creator_notes}}{{/if}}
{{#if scenario}}scenario: {{scenario}}{{/if}}
{{#if tags}}tags: {{tags}}{{/if}}

Fill in the remaining empty fields with creative, consistent content. Reference character as "{{char}}" and user as "{{user}}" where appropriate.`,
    promptTemplateCharacterBookGenerate: `Generate 3 to 5 character-book entries for this character.

Character context:
{{#if name}}Name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}
{{#if first_mes}}First message: {{first_mes}}{{/if}}
{{#if creator_notes}}Creator notes: {{creator_notes}}{{/if}}
{{#if tags}}Tags: {{tags}}{{/if}}

Output valid JSON only as an array.
Each item must use this shape:
{"name":"entry title","keys":"keyword1, keyword2","content":"entry text"}

Keep entries concise and useful for roleplay context injection.`,
    promptTemplateCharacterBookRefine: `Refine this single character-book entry for clarity and usefulness.

Character context:
{{#if name}}Name: {{name}}{{/if}}
{{#if description}}Description: {{description}}{{/if}}
{{#if scenario}}Scenario: {{scenario}}{{/if}}

Current entry input:
{{#if userInput}}{{userInput}}{{/if}}

Output valid JSON only in this exact shape:
{"name":"entry title","keys":"keyword1, keyword2","content":"entry text"}

Do not include markdown fences or explanations.`,
    // Backward-compatible aliases used by older builds and persisted settings.
    promptTemplateLorebookGenerate: '',
    promptTemplateLorebookRefine: '',
    comfyApiType: 'local',
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyApiKey: '',
    comfyEndpointId: '',
    comfyWorkflow: '{\n  \"1\": {\n    \"inputs\": {\n      \"samples\": [\n        \"5\",\n        0\n      ],\n      \"vae\": [\n        \"4\",\n        0\n      ]\n    },\n    \"class_type\": \"VAEDecode\",\n    \"_meta\": {\n      \"title\": \"VAE Decode\"\n    }\n  },\n  \"2\": {\n    \"inputs\": {\n      \"text\": \"%prompt%\",\n      \"clip\": [\n        \"8\",\n        0\n      ]\n    },\n    \"class_type\": \"CLIPTextEncode\",\n    \"_meta\": {\n      \"title\": \"CLIP Text Encode (Positive Prompt)\"\n    }\n  },\n  \"3\": {\n    \"inputs\": {\n      \"text\": \"%negative_prompt%\",\n      \"clip\": [\n        \"8\",\n        0\n      ]\n    },\n    \"class_type\": \"CLIPTextEncode\",\n    \"_meta\": {\n      \"title\": \"CLIP Text Encode (Negative Prompt)\"\n    }\n  },\n  \"4\": {\n    \"inputs\": {\n      \"vae_name\": \"qwen_image_vae.safetensors\"\n    },\n    \"class_type\": \"VAELoader\",\n    \"_meta\": {\n      \"title\": \"Load VAE\"\n    }\n  },\n  \"5\": {\n    \"inputs\": {\n      \"seed\": 525350692662308,\n      \"steps\": 30,\n      \"cfg\": 4,\n      \"sampler_name\": \"er_sde\",\n      \"scheduler\": \"simple\",\n      \"denoise\": 1,\n      \"model\": [\n        \"7\",\n        0\n      ],\n      \"positive\": [\n        \"2\",\n        0\n      ],\n      \"negative\": [\n        \"3\",\n        0\n      ],\n      \"latent_image\": [\n        \"6\",\n        0\n      ]\n    },\n    \"class_type\": \"KSampler\",\n    \"_meta\": {\n      \"title\": \"KSampler\"\n    }\n  },\n  \"6\": {\n    \"inputs\": {\n      \"width\": \"%width%\",\n      \"height\": \"%height%\",\n      \"batch_size\": 1\n    },\n    \"class_type\": \"EmptyLatentImage\",\n    \"_meta\": {\n      \"title\": \"Empty Latent Image\"\n    }\n  },\n  \"7\": {\n    \"inputs\": {\n      \"unet_name\": \"animaOfficial_preview2.safetensors\",\n      \"weight_dtype\": \"default\"\n    },\n    \"class_type\": \"UNETLoader\",\n    \"_meta\": {\n      \"title\": \"Load Diffusion Model\"\n    }\n  },\n  \"8\": {\n    \"inputs\": {\n      \"clip_name\": \"qwen_3_06b_base.safetensors\",\n      \"type\": \"stable_diffusion\",\n      \"device\": \"default\"\n    },\n    \"class_type\": \"CLIPLoader\",\n    \"_meta\": {\n      \"title\": \"Load CLIP\"\n    }\n  },\n  \"9\": {\n    \"inputs\": {\n      \"filename_prefix\": \"charbrowser\",\n      \"images\": [\n        \"1\",\n        0\n      ]\n    },\n    \"class_type\": \"SaveImage\",\n    \"_meta\": {\n      \"title\": \"Save Image\"\n    }\n  }\n}',
    comfyPositivePrompt: '{{description}}, highly detailed, character portrait, best quality',
    comfyNegativePrompt: 'blurry, malformed hands, bad anatomy, low quality',
    deleteRequiresConfirmation: true,
};

/**
 * Provider endpoint presets used by LLM settings UI and request routing.
 */
export const LLM_API_ENDPOINTS = {
    openai: [
        { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', needsAuth: true },
        { value: 'openrouter', label: 'OpenRouter.ai', endpoint: 'https://openrouter.ai/api/v1', needsAuth: true },
        { value: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', needsAuth: true },
        { value: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', needsAuth: true },
        { value: 'nanogpt', label: 'NanoGPT', endpoint: 'https://nano-gpt.com/api/v1', needsAuth: true },
        { value: 'custom', label: 'Custom', endpoint: 'http://localhost:1234/v1', needsAuth: false },
    ],
    ollama: [
        { value: 'local', label: 'Local Ollama', endpoint: 'http://localhost:11434', needsAuth: false },
    ],
};

let cachedSettings = { ...DEFAULT_SETTINGS };
let appDataPath = '';
let initializePromise = null;

/**
 * Returns one endpoint preset descriptor by api type and preset value.
 * @param {string} apiType
 * @param {string} endpointPreset
 */
export function getLlmEndpointPreset(apiType, endpointPreset) {
    const key = apiType === 'ollama' ? 'ollama' : 'openai';
    const options = LLM_API_ENDPOINTS[key] || [];
    return options.find((item) => item.value === endpointPreset) || null;
}

/**
 * Infers endpoint preset key from persisted endpoint URL.
 * @param {string} apiType
 * @param {string} endpoint
 * @returns {string}
 */
export function inferLlmEndpointPreset(apiType, endpoint) {
    const normalizedEndpoint = String(endpoint || '').trim().toLowerCase();
    if (apiType === 'ollama') {
        return 'local';
    }
    if (normalizedEndpoint.includes('openrouter.ai')) {
        return 'openrouter';
    }
    if (normalizedEndpoint.includes('api.groq.com')) {
        return 'groq';
    }
    if (normalizedEndpoint.includes('api.deepseek.com')) {
        return 'deepseek';
    }
    if (normalizedEndpoint.includes('api.openai.com')) {
        return 'openai';
    }
    if (normalizedEndpoint.includes('nano-gpt.com')) {
        return 'nanogpt';
    }
    return 'custom';
}

/**
 * Resolves backend provider key from current settings payload.
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 * @returns {'openai'|'openrouter'|'groq'|'deepseek'|'custom'|'ollama'}
 */
export function resolveLlmProvider(settings) {
    const apiType = settings?.llmApiType === 'ollama' ? 'ollama' : 'openai';
    if (apiType === 'ollama') {
        return 'ollama';
    }

    const endpointPreset = String(settings?.llmApiEndpoint || '').trim().toLowerCase();
    if (endpointPreset === 'openrouter' || endpointPreset === 'groq' || endpointPreset === 'deepseek' || endpointPreset === 'openai' || endpointPreset === 'nanogpt') {
        return endpointPreset;
    }
    return 'custom';
}

/**
 * Returns merged settings object with defaults and basic legacy normalization.
 * @param {Record<string, unknown>} raw
 */
function mergeSettings(raw) {
    const merged = {
        ...DEFAULT_SETTINGS,
        ...(raw && typeof raw === 'object' ? raw : {}),
    };

    if (raw?.promptTemplateName === LEGACY_DEFAULT_PROMPT_TEMPLATE_NAME) {
        merged.promptTemplateName = DEFAULT_SETTINGS.promptTemplateName;
    }

    if (!merged.llmApiType) {
        const endpoint = String(merged.llmEndpoint || '').toLowerCase();
        merged.llmApiType = endpoint.includes('localhost:11434') || endpoint.includes('ollama') ? 'ollama' : 'openai';
    }

    if (!merged.llmApiEndpoint) {
        merged.llmApiEndpoint = inferLlmEndpointPreset(merged.llmApiType, merged.llmEndpoint);
    }

    if (raw?.showThumbnails == null && raw?.preserveThumbnails != null) {
        merged.showThumbnails = Boolean(raw.preserveThumbnails);
    }

    if (!merged.promptTemplateCharacterBookGenerate && merged.promptTemplateLorebookGenerate) {
        merged.promptTemplateCharacterBookGenerate = merged.promptTemplateLorebookGenerate;
    }
    if (!merged.promptTemplateCharacterBookRefine && merged.promptTemplateLorebookRefine) {
        merged.promptTemplateCharacterBookRefine = merged.promptTemplateLorebookRefine;
    }
    if (!merged.promptTemplateLorebookGenerate && merged.promptTemplateCharacterBookGenerate) {
        merged.promptTemplateLorebookGenerate = merged.promptTemplateCharacterBookGenerate;
    }
    if (!merged.promptTemplateLorebookRefine && merged.promptTemplateCharacterBookRefine) {
        merged.promptTemplateLorebookRefine = merged.promptTemplateCharacterBookRefine;
    }

    merged.comfyApiType = merged.comfyApiType === 'runpod' ? 'runpod' : 'local';

    return merged;
}

/**
 * Loads settings from backend app-data store into an in-memory cache.
 * The cache preserves synchronous access for existing UI callers.
 */
export async function initializeSettings() {
    if (initializePromise) {
        return initializePromise;
    }

    initializePromise = (async () => {
        try {
            const raw = await getAppSettings();
            cachedSettings = mergeSettings(raw && typeof raw === 'object' ? raw : {});
        } catch {
            cachedSettings = { ...DEFAULT_SETTINGS };
        }

        try {
            appDataPath = await getAppDataPath();
        } catch {
            appDataPath = '';
        }
    })();

    return initializePromise;
}

/**
 * Returns current settings from the in-memory cache.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
    return { ...cachedSettings };
}

/**
 * Persists the provided settings object to backend app-data store.
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 */
export async function saveSettings(settings) {
    const merged = {
        ...cachedSettings,
        ...settings,
    };

    cachedSettings = mergeSettings(merged);
    await saveAppSettings(cachedSettings);
}

/**
 * Returns resolved path to unified backend app-data file when available.
 * @returns {string}
 */
export function getAppDataPathCached() {
    return appDataPath;
}
