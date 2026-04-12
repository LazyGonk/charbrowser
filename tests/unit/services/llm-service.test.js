import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

describe('llm-service', () => {
    beforeEach(() => {
        vi.resetModules();
        invokeMock.mockReset();
        vi.unstubAllGlobals();
    });

    it('fetches model list through tauri invoke for openai-compatible endpoint', async () => {
        invokeMock.mockResolvedValue(['gpt-4o-mini', 'gpt-4.1']);
        const svc = await import('../../../src/services/llm-service.js');

        const models = await svc.fetchAvailableModels({
            endpoint: ' https://api.openai.com/v1/ ',
            apiType: 'openai',
            apiKey: 'k',
        });

        expect(models).toEqual(['gpt-4o-mini', 'gpt-4.1']);
        expect(invokeMock).toHaveBeenCalledWith('get_llm_models', {
            endpoint: 'https://api.openai.com/v1',
            apiKey: 'k',
            apiType: 'openai',
        });
    });

    it('falls back to fetch for ollama when tauri invoke fails', async () => {
        invokeMock.mockRejectedValue(new Error('backend unavailable'));
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ models: [{ name: 'qwen2.5' }, { name: 'phi3' }] }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const svc = await import('../../../src/services/llm-service.js');
        const models = await svc.fetchAvailableModels({
            endpoint: 'http://localhost:11434',
        });

        expect(models).toEqual(['qwen2.5', 'phi3']);
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', {
            method: 'GET',
            headers: {},
        });
    });

    it('rejects empty endpoint or model for generation calls', async () => {
        const svc = await import('../../../src/services/llm-service.js');

        await expect(
            svc.generateFieldWithOpenAiCompatible({
                endpoint: '',
                apiKey: '',
                model: 'x',
                temperature: 0.7,
                maxTokens: 100,
                systemPrompt: '',
                targetField: 'name',
                formData: { name: '', description: '', firstMes: '', creatorNotes: '', scenario: '', tags: [] },
            })
        ).rejects.toThrow('LLM endpoint is required.');

        await expect(
            svc.generateFieldWithOpenAiCompatible({
                endpoint: 'http://localhost:1234/v1',
                apiKey: '',
                model: ' ',
                temperature: 0.7,
                maxTokens: 100,
                systemPrompt: '',
                targetField: 'name',
                formData: { name: '', description: '', firstMes: '', creatorNotes: '', scenario: '', tags: [] },
            })
        ).rejects.toThrow('LLM model is required.');
    });

    it('normalizes outgoing chat messages and injects system prompt', async () => {
        invokeMock.mockResolvedValue(' hello ');
        const svc = await import('../../../src/services/llm-service.js');

        const content = await svc.callLlmChatWithMessages({
            endpoint: 'http://localhost:1234/v1/',
            model: 'test-model',
            systemPrompt: 'system',
            messages: [
                { role: 'user', content: ' hi ' },
                { role: 'assistant', content: '   ' },
                { role: '', content: 'x' },
            ],
            temperature: 0.5,
            maxTokens: 256,
        });

        expect(content).toBe('hello');
        expect(invokeMock).toHaveBeenCalledWith('call_llm_chat', {
            endpoint: 'http://localhost:1234/v1',
            apiKey: null,
            apiType: 'openai',
            model: 'test-model',
            messages: [
                { role: 'system', content: 'system' },
                { role: 'user', content: 'hi' },
            ],
            temperature: 0.5,
            maxTokens: 256,
        });
    });

    it('rejects chat calls without usable messages', async () => {
        const svc = await import('../../../src/services/llm-service.js');

        await expect(
            svc.callLlmChatWithMessages({
                endpoint: 'http://localhost:1234/v1',
                model: 'x',
                messages: [{ role: 'user', content: '   ' }],
            })
        ).rejects.toThrow('At least one message is required.');
    });
});
