import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
    getAppSettings: vi.fn(),
    getAppDataPath: vi.fn(),
    saveAppSettings: vi.fn(),
}));

vi.mock('../../../src/services/tauri-api.js', () => ({
    getAppSettings: tauriMocks.getAppSettings,
    getAppDataPath: tauriMocks.getAppDataPath,
    saveAppSettings: tauriMocks.saveAppSettings,
}));

describe('settings-service', () => {
    beforeEach(() => {
        vi.resetModules();
        tauriMocks.getAppSettings.mockReset();
        tauriMocks.getAppDataPath.mockReset();
        tauriMocks.saveAppSettings.mockReset();
    });

    it('infers endpoint presets by provider URL', async () => {
        const svc = await import('../../../src/services/settings-service.js');

        expect(svc.inferLlmEndpointPreset('openai', 'https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(svc.inferLlmEndpointPreset('openai', 'https://api.groq.com/openai/v1')).toBe('groq');
        expect(svc.inferLlmEndpointPreset('openai', 'https://api.deepseek.com/v1')).toBe('deepseek');
        expect(svc.inferLlmEndpointPreset('openai', 'https://api.openai.com/v1')).toBe('openai');
        expect(svc.inferLlmEndpointPreset('openai', 'https://nano-gpt.com/api/v1')).toBe('nanogpt');
        expect(svc.inferLlmEndpointPreset('openai', 'http://localhost:1234/v1')).toBe('custom');
        expect(svc.inferLlmEndpointPreset('ollama', 'anything')).toBe('local');
    });

    it('resolves provider from api type and endpoint preset', async () => {
        const svc = await import('../../../src/services/settings-service.js');

        expect(svc.resolveLlmProvider({ llmApiType: 'ollama' })).toBe('ollama');
        expect(svc.resolveLlmProvider({ llmApiType: 'openai', llmApiEndpoint: 'openrouter' })).toBe('openrouter');
        expect(svc.resolveLlmProvider({ llmApiType: 'openai', llmApiEndpoint: 'groq' })).toBe('groq');
        expect(svc.resolveLlmProvider({ llmApiType: 'openai', llmApiEndpoint: 'deepseek' })).toBe('deepseek');
        expect(svc.resolveLlmProvider({ llmApiType: 'openai', llmApiEndpoint: 'openai' })).toBe('openai');
        expect(svc.resolveLlmProvider({ llmApiType: 'openai', llmApiEndpoint: 'custom' })).toBe('custom');
    });

    it('returns endpoint preset descriptors and null for unknown values', async () => {
        const svc = await import('../../../src/services/settings-service.js');

        const preset = svc.getLlmEndpointPreset('openai', 'openai');
        expect(preset?.endpoint).toBe('https://api.openai.com/v1');
        expect(svc.getLlmEndpointPreset('openai', 'does-not-exist')).toBeNull();
    });

    it('initializes settings from backend and applies legacy normalization', async () => {
        tauriMocks.getAppSettings.mockResolvedValue({
            llmEndpoint: 'http://localhost:11434',
            promptTemplateLorebookGenerate: 'legacy generate',
            promptTemplateLorebookRefine: 'legacy refine',
            comfyApiType: 'invalid',
        });
        tauriMocks.getAppDataPath.mockResolvedValue('C:/app/data.json');

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();
        const loaded = svc.loadSettings();

        expect(loaded.llmApiType).toBe('openai');
        expect(loaded.llmApiEndpoint).toBe('custom');
        expect(loaded.promptTemplateCharacterBookGenerate).toContain('Generate 3 to 5 character-book entries');
        expect(loaded.promptTemplateCharacterBookRefine).toContain('Refine this single character-book entry');
        expect(loaded.promptTemplateLorebookGenerate).toBe('legacy generate');
        expect(loaded.promptTemplateLorebookRefine).toBe('legacy refine');
        expect(loaded.comfyApiType).toBe('local');
        expect(svc.getAppDataPathCached()).toBe('C:/app/data.json');
    });

    it('falls back to defaults when initialization backend calls fail', async () => {
        tauriMocks.getAppSettings.mockRejectedValue(new Error('settings unavailable'));
        tauriMocks.getAppDataPath.mockRejectedValue(new Error('path unavailable'));

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();
        const loaded = svc.loadSettings();

        expect(loaded.llmApiType).toBe('openai');
        expect(loaded.showThumbnails).toBe(true);
        expect(svc.getAppDataPathCached()).toBe('');
    });

    it('migrates legacy preserveThumbnails to showThumbnails when needed', async () => {
        tauriMocks.getAppSettings.mockResolvedValue({
            preserveThumbnails: false,
        });
        tauriMocks.getAppDataPath.mockResolvedValue('');

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();
        const loaded = svc.loadSettings();

        expect(loaded.showThumbnails).toBe(false);
    });

    it('prefers explicit showThumbnails over legacy preserveThumbnails', async () => {
        tauriMocks.getAppSettings.mockResolvedValue({
            showThumbnails: true,
            preserveThumbnails: false,
        });
        tauriMocks.getAppDataPath.mockResolvedValue('');

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();
        const loaded = svc.loadSettings();

        expect(loaded.showThumbnails).toBe(true);
    });

    it('saves merged settings with normalization and updates cache', async () => {
        tauriMocks.getAppSettings.mockResolvedValue({ llmApiType: 'openai' });
        tauriMocks.getAppDataPath.mockResolvedValue('');

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();

        await svc.saveSettings({ llmModel: 'gpt-test', comfyApiType: 'runpod' });

        expect(tauriMocks.saveAppSettings).toHaveBeenCalledTimes(1);
        const savedPayload = tauriMocks.saveAppSettings.mock.calls[0][0];
        expect(savedPayload.llmModel).toBe('gpt-test');
        expect(savedPayload.comfyApiType).toBe('runpod');
        expect(svc.loadSettings().llmModel).toBe('gpt-test');
    });

    it('persists deleteRequiresConfirmation when toggled off', async () => {
        tauriMocks.getAppSettings.mockResolvedValue({});
        tauriMocks.getAppDataPath.mockResolvedValue('');

        const svc = await import('../../../src/services/settings-service.js');
        await svc.initializeSettings();

        expect(svc.loadSettings().deleteRequiresConfirmation).toBe(true);

        await svc.saveSettings({ deleteRequiresConfirmation: false });

        expect(tauriMocks.saveAppSettings).toHaveBeenCalledTimes(1);
        const savedPayload = tauriMocks.saveAppSettings.mock.calls[0][0];
        expect(savedPayload.deleteRequiresConfirmation).toBe(false);
        expect(svc.loadSettings().deleteRequiresConfirmation).toBe(false);
    });
});
