import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const settingsMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('../../../src/services/settings-service.js', () => ({
    loadSettings: settingsMock,
}));

describe('comfyui-service', () => {
    beforeEach(() => {
        vi.resetModules();
        invokeMock.mockReset();
        settingsMock.mockReset();
    });

    it('validates workflow json placeholders and format', async () => {
        const svc = await import('../../../src/services/comfyui-service.js');

        expect(svc.validateWorkflowJson('')).toEqual({ valid: false, message: 'Workflow is empty' });

        const invalid = svc.validateWorkflowJson('{bad');
        expect(invalid.valid).toBe(false);
        expect(invalid.message).toContain('Invalid JSON:');

        const missing = svc.validateWorkflowJson('{"node":{"inputs":{"text":"%prompt%"}}}');
        expect(missing.valid).toBe(false);
        expect(missing.message).toContain('%negative_prompt%');

        const good = svc.validateWorkflowJson(
            '{"n":{"inputs":{"a":"%prompt%","b":"%negative_prompt%","w":"%width%","h":"%height%"}}}'
        );
        expect(good.valid).toBe(true);
    });

    it('tests local and runpod connection argument validation', async () => {
        const svc = await import('../../../src/services/comfyui-service.js');

        await expect(svc.testComfyConnection({ comfyApiType: 'local', endpoint: '' })).rejects.toThrow('Endpoint is empty');
        await expect(
            svc.testComfyConnection({ comfyApiType: 'runpod', apiKey: '', endpointId: '' })
        ).rejects.toThrow('RunPod API key and endpoint ID are required');
    });

    it('forwards test connection call to backend invoke', async () => {
        invokeMock.mockResolvedValue('ok');
        const svc = await import('../../../src/services/comfyui-service.js');

        const result = await svc.testComfyConnection({
            comfyApiType: 'runpod',
            endpoint: ' https://api.runpod.ai/ ',
            apiKey: 'k',
            endpointId: 'e',
        });

        expect(result).toBe('ok');
        expect(invokeMock).toHaveBeenCalledWith('comfyui_test_connection', {
            endpoint: 'https://api.runpod.ai',
            apiType: 'runpod',
            apiKey: 'k',
            endpointId: 'e',
        });
    });

    it('fails execute workflow when local endpoint is missing', async () => {
        settingsMock.mockReturnValue({
            comfyApiType: 'local',
            comfyEndpoint: '',
            comfyWorkflow: '{}',
            comfyPositivePrompt: '{{description}}',
            comfyNegativePrompt: '',
        });

        const svc = await import('../../../src/services/comfyui-service.js');
        await expect(svc.executeComfyWorkflow('desc', () => {})).rejects.toThrow(
            'ComfyUI endpoint not configured. Go to Settings > ComfyUI to configure.'
        );
    });

    it('fails execute workflow when runpod credentials are missing', async () => {
        settingsMock.mockReturnValue({
            comfyApiType: 'runpod',
            comfyEndpoint: 'https://api.runpod.ai',
            comfyApiKey: '',
            comfyEndpointId: '',
            comfyWorkflow: '{}',
            comfyPositivePrompt: '{{description}}',
            comfyNegativePrompt: '',
        });

        const svc = await import('../../../src/services/comfyui-service.js');
        await expect(svc.executeComfyWorkflow('desc', () => {})).rejects.toThrow(
            'RunPod API key and endpoint ID are required. Go to Settings > ComfyUI to configure.'
        );
    });

    it('fails execute workflow on invalid workflow json', async () => {
        settingsMock.mockReturnValue({
            comfyApiType: 'local',
            comfyEndpoint: 'http://127.0.0.1:8188',
            comfyWorkflow: '{bad',
            comfyPositivePrompt: '{{description}}',
            comfyNegativePrompt: '',
        });

        const svc = await import('../../../src/services/comfyui-service.js');
        await expect(svc.executeComfyWorkflow('desc', () => {})).rejects.toThrow(
            'Invalid workflow JSON. Check format in Settings > ComfyUI.'
        );
    });
});
