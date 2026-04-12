import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './settings-service.js';
import {
    COMFYUI_DEFAULT_HEIGHT,
    COMFYUI_DEFAULT_WIDTH,
    COMFYUI_MAX_POLL_ATTEMPTS,
    COMFYUI_POLL_INTERVAL_MS,
    COMFYUI_TIMEOUT_MS,
} from '../constants.js';

/**
 * Pauses execution for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replaces {{description}} placeholder in positive prompt template with the character description.
 * @param {string} description - Character description text
 * @param {string} template - Positive prompt template containing {{description}}
 * @returns {string} Resolved positive prompt
 */
function buildPositivePrompt(description, template) {
    if (!template) {
        return description || '';
    }
    return template.replace(/\{\{description\}\}/gi, description || '').trim();
}

/**
 * Normalizes endpoint values by trimming whitespace and one trailing slash.
 * @param {string} endpoint
 * @returns {string}
 */
function normalizeEndpoint(endpoint) {
    return String(endpoint || '').trim().replace(/\/+$/, '');
}

/**
 * Normalizes Comfy API type to one of supported transport modes.
 * @param {unknown} apiType
 * @returns {'local'|'runpod'}
 */
function normalizeComfyApiType(apiType) {
    return String(apiType || '').trim().toLowerCase() === 'runpod' ? 'runpod' : 'local';
}

/**
 * Builds resolved Comfy transport settings from persisted app settings.
 * @param {ReturnType<typeof loadSettings>} settings
 */
function resolveComfyTransport(settings) {
    const apiType = normalizeComfyApiType(settings?.comfyApiType);
    return {
        apiType,
        endpoint: normalizeEndpoint(settings?.comfyEndpoint || ''),
        apiKey: String(settings?.comfyApiKey || '').trim(),
        endpointId: String(settings?.comfyEndpointId || '').trim(),
    };
}

/**
 * Recursively replaces workflow string placeholders with runtime values.
 * Supported placeholders: %prompt%, %negative_prompt%, %width%, %height%
 * @param {unknown} value
 * @param {{prompt: string, negativePrompt: string, width: number, height: number}} vars
 * @returns {unknown}
 */
function replaceWorkflowPlaceholders(value, vars) {
    if (Array.isArray(value)) {
        return value.map((entry) => replaceWorkflowPlaceholders(entry, vars));
    }

    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = replaceWorkflowPlaceholders(entry, vars);
        }
        return out;
    }

    if (typeof value !== 'string') {
        return value;
    }

    if (value === '%width%') {
        return vars.width;
    }
    if (value === '%height%') {
        return vars.height;
    }

    return value
        .replace(/%prompt%/gi, vars.prompt)
        .replace(/%negative_prompt%/gi, vars.negativePrompt)
        .replace(/%width%/gi, String(vars.width))
        .replace(/%height%/gi, String(vars.height));
}

/**
 * Injects positive and negative prompts into a ComfyUI workflow JSON object.
 * Runtime values are injected exclusively via workflow placeholders.
 * @param {object} workflow - Workflow JSON as parsed object
 * @param {string} positivePrompt
 * @param {string} negativePrompt
 * @returns {object} Deep-cloned workflow with injected prompts
 */
function injectPrompts(workflow, positivePrompt, negativePrompt) {
    const modified = /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(workflow)));

    const width = COMFYUI_DEFAULT_WIDTH;
    const height = COMFYUI_DEFAULT_HEIGHT;

    return /** @type {Record<string, any>} */ (replaceWorkflowPlaceholders(modified, {
        prompt: positivePrompt,
        negativePrompt,
        width,
        height,
    }));
}

/**
 * Extracts output image descriptors from a ComfyUI history entry.
 * @param {object} historyEntry - Single prompt entry from /history/{id}
 * @returns {Array<{filename: string, subfolder: string, type: string}>}
 */
function findOutputImages(historyEntry) {
    const images = [];
    const outputs = historyEntry?.outputs;
    if (!outputs) {
        return images;
    }
    for (const nodeId of Object.keys(outputs)) {
        const nodeOutput = outputs[nodeId];
        if (Array.isArray(nodeOutput?.images)) {
            for (const img of nodeOutput.images) {
                if (img.filename) {
                    images.push({
                        filename: img.filename,
                        subfolder: img.subfolder || '',
                        type: img.type || 'output',
                    });
                }
            }
        }
    }
    return images;
}

/**
 * Downloads a single image from ComfyUI /view endpoint and returns it as a data URL.
 * @param {{filename: string, subfolder: string, type: string}} imageInfo
 * @param {string} endpoint - ComfyUI base URL
 * @returns {Promise<string>} data URL
 */
async function downloadImage(imageInfo, endpoint) {
    return invoke('comfyui_download_image', {
        endpoint,
        filename: imageInfo.filename,
        subfolder: imageInfo.subfolder || '',
        imageType: imageInfo.type || 'output',
    });
}

/**
 * Converts one URL image resource into a data URL for preview usage.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchImageAsDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Image fetch failed (${response.status})`);
    }

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read image blob'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Resolves the first usable image output from RunPod response payload.
 * @param {any} output
 * @returns {Promise<string>}
 */
async function extractRunpodImageDataUrl(output) {
    if (!output || typeof output !== 'object') {
        throw new Error('RunPod response did not include structured output');
    }

    const outputImages = [];
    if (Array.isArray(output.images)) {
        outputImages.push(...output.images);
    }

    if (output.outputs && typeof output.outputs === 'object') {
        for (const nodeOutput of Object.values(output.outputs)) {
            if (Array.isArray(nodeOutput?.images)) {
                outputImages.push(...nodeOutput.images);
            }
        }
    }

    for (const image of outputImages) {
        if (typeof image === 'string') {
            if (image.startsWith('data:image/')) {
                return image;
            }
            if (/^https?:\/\//i.test(image)) {
                return await fetchImageAsDataUrl(image);
            }
        }

        if (!image || typeof image !== 'object') {
            continue;
        }

        const dataUrl = String(image.data_url || image.dataUrl || '').trim();
        if (dataUrl.startsWith('data:image/')) {
            return dataUrl;
        }

        const url = String(image.url || image.image_url || '').trim();
        if (/^https?:\/\//i.test(url)) {
            return await fetchImageAsDataUrl(url);
        }

        const base64 = String(image.base64 || image.b64_json || '').trim();
        if (base64) {
            const mime = String(image.mime || image.mime_type || 'image/png').trim() || 'image/png';
            return `data:${mime};base64,${base64}`;
        }
    }

    throw new Error('RunPod completed but no output image was found');
}

/**
 * Polls ComfyUI /history/{promptId} until generation completes or times out.
 * Reports elapsed time via onProgress callback.
 * @param {string} promptId
 * @param {string} endpoint - ComfyUI base URL
 * @param {(status: string) => void} onProgress
 * @returns {Promise<string>} data URL of first output image
 */
async function pollForResult(promptId, endpoint, onProgress) {
    const maxAttempts = COMFYUI_MAX_POLL_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(COMFYUI_POLL_INTERVAL_MS);

        let history;
        try {
            history = await invoke('comfyui_get_history', {
                endpoint,
                promptId,
            });
        } catch {
            continue;
        }

        const entry = history[promptId];
        if (!entry) {
            continue;
        }

        if (entry?.status?.status_str === 'error' || entry?.status?.errored) {
            const msg = entry?.status?.messages?.find?.(([type]) => type === 'execution_error')?.[1]?.exception_message;
            throw new Error(`ComfyUI generation error: ${msg || 'unknown error'}`);
        }

        if (entry?.status?.completed) {
            const images = findOutputImages(entry);
            if (images.length === 0) {
                throw new Error('Workflow completed but no output image was found');
            }
            return await downloadImage(images[0], endpoint);
        }

        const elapsed = attempt + 1;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        onProgress(`Generating... ${mins}:${secs.toString().padStart(2, '0')}`);
    }

    throw new Error(`Generation timed out after ${Math.floor(COMFYUI_TIMEOUT_MS / 60000)} minutes`);
}

/**
 * Polls RunPod /status endpoint via backend command until completion or timeout.
 * @param {string} jobId
 * @param {{endpoint: string, apiKey: string, endpointId: string}} transport
 * @param {(status: string) => void} onProgress
 * @returns {Promise<string>}
 */
async function pollRunpodForResult(jobId, transport, onProgress) {
    const maxAttempts = COMFYUI_MAX_POLL_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await sleep(COMFYUI_POLL_INTERVAL_MS);

        let statusPayload;
        try {
            statusPayload = await invoke('comfyui_get_history', {
                endpoint: transport.endpoint,
                promptId: jobId,
                apiType: 'runpod',
                apiKey: transport.apiKey,
                endpointId: transport.endpointId,
            });
        } catch {
            continue;
        }

        const status = String(statusPayload?.status || '').toUpperCase();
        if (status === 'COMPLETED') {
            return await extractRunpodImageDataUrl(statusPayload?.output);
        }

        if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
            const errorText = String(statusPayload?.error || statusPayload?.message || 'unknown error');
            throw new Error(`RunPod generation failed: ${errorText}`);
        }

        if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
            onProgress('RunPod worker active...');
        } else {
            onProgress('RunPod worker warming up...');
        }
    }

    throw new Error(`Generation timed out after ${Math.floor(COMFYUI_TIMEOUT_MS / 60000)} minutes`);
}

/**
 * Executes a ComfyUI image generation workflow from a character description.
 * Loads endpoint, workflow, and prompt templates from settings.
 * Injects the character description into the positive prompt template.
 *
 * @param {string} description - Character description to use as the visual base
 * @param {(status: string) => void} onProgress - Receives human-readable status updates
 * @returns {Promise<string>} Base64 data URL of the generated image
 */
export async function executeComfyWorkflow(description, onProgress) {
    const settings = loadSettings();
    const transport = resolveComfyTransport(settings);

    if (transport.apiType === 'local' && !transport.endpoint) {
        throw new Error('ComfyUI endpoint not configured. Go to Settings > ComfyUI to configure.');
    }
    if (transport.apiType === 'runpod' && (!transport.apiKey || !transport.endpointId)) {
        throw new Error('RunPod API key and endpoint ID are required. Go to Settings > ComfyUI to configure.');
    }

    const workflowText = (settings.comfyWorkflow || '').trim();
    if (!workflowText) {
        throw new Error('No workflow configured. Paste a workflow JSON in Settings > ComfyUI.');
    }

    let workflow;
    try {
        workflow = JSON.parse(workflowText);
    } catch {
        throw new Error('Invalid workflow JSON. Check format in Settings > ComfyUI.');
    }

    const positiveTemplate = settings.comfyPositivePrompt || '{{description}}';
    const negativePrompt = settings.comfyNegativePrompt || '';
    const positivePrompt = buildPositivePrompt(description, positiveTemplate);
    const modifiedWorkflow = injectPrompts(workflow, positivePrompt, negativePrompt);

    onProgress('Submitting workflow...');

    const promptId = await invoke('comfyui_submit_prompt', {
        endpoint: transport.endpoint,
        workflow: modifiedWorkflow,
        apiType: transport.apiType,
        apiKey: transport.apiKey,
        endpointId: transport.endpointId,
    });
    if (!promptId) {
        throw new Error(transport.apiType === 'runpod'
            ? 'RunPod did not return a job id'
            : 'ComfyUI did not return a prompt_id');
    }

    onProgress('Generating image...');
    const imageDataUrl = transport.apiType === 'runpod'
        ? await pollRunpodForResult(promptId, transport, onProgress)
        : await pollForResult(promptId, transport.endpoint, onProgress);
    onProgress('Done');
    return imageDataUrl;
}

/**
 * Tests connectivity to the ComfyUI server by hitting /system_stats.
 * Returns a short status string suitable for display.
 * @param {{comfyApiType?: 'local'|'runpod', endpoint?: string, apiKey?: string, endpointId?: string}} options
 * @returns {Promise<string>} Human-readable result message
 */
export async function testComfyConnection(options) {
    const comfyApiType = normalizeComfyApiType(options?.comfyApiType);
    const endpoint = normalizeEndpoint(options?.endpoint || '');
    const apiKey = String(options?.apiKey || '').trim();
    const endpointId = String(options?.endpointId || '').trim();

    if (comfyApiType === 'local' && !endpoint) {
        throw new Error('Endpoint is empty');
    }
    if (comfyApiType === 'runpod' && (!apiKey || !endpointId)) {
        throw new Error('RunPod API key and endpoint ID are required');
    }

    return invoke('comfyui_test_connection', {
        endpoint,
        apiType: comfyApiType,
        apiKey,
        endpointId,
    });
}

/**
 * Validates a workflow JSON string and ensures all required placeholders exist.
 * @param {string} workflowText
 * @returns {{ valid: boolean, message: string }}
 */
export function validateWorkflowJson(workflowText) {
    if (!workflowText || !workflowText.trim()) {
        return { valid: false, message: 'Workflow is empty' };
    }

    let workflow;
    try {
        workflow = JSON.parse(workflowText);
    } catch (e) {
        return { valid: false, message: `Invalid JSON: ${e.message}` };
    }

    if (typeof workflow !== 'object' || Array.isArray(workflow) || workflow === null) {
        return { valid: false, message: 'Workflow must be a JSON object (node map)' };
    }

    const normalized = JSON.stringify(workflow).toLowerCase();
    const requiredTokens = ['%prompt%', '%negative_prompt%', '%width%', '%height%'];
    const missingTokens = requiredTokens.filter((token) => !normalized.includes(token));

    if (missingTokens.length > 0) {
        return {
            valid: false,
            message: `Missing required placeholders: ${missingTokens.join(', ')}`,
        };
    }

    return { valid: true, message: 'Valid — all required placeholders are present' };
}
