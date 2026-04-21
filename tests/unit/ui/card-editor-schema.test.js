import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/dom.js', () => ({
    dom: {},
}));

vi.mock('../../../src/state.js', () => ({
    state: {
        cardEditorMode: 'view',
        selectedFile: null,
        currentDirectory: null,
        preserveEmptySelection: false,
    },
}));

vi.mock('../../../src/services/tauri-api.js', () => ({
    appendLlmIterationResponse: vi.fn(),
    clearLlmIterationHistory: vi.fn(),
    createPngCharacterCard: vi.fn(),
    getImageDataUrl: vi.fn(),
    getLlmIterationResponses: vi.fn(),
    pickImageFilePath: vi.fn(),
    pickOpenJsonPath: vi.fn(),
    pickSaveJsonPath: vi.fn(),
    pickSavePngPath: vi.fn(),
    readTextFile: vi.fn(),
    saveTextFile: vi.fn(),
    upsertPngCharacterCard: vi.fn(),
}));

vi.mock('../../../src/services/llm-service.js', () => ({
    generateFieldWithOpenAiCompatible: vi.fn(),
}));

vi.mock('../../../src/services/comfyui-service.js', () => ({
    executeComfyWorkflow: vi.fn(),
}));

vi.mock('../../../src/services/settings-service.js', () => ({
    loadSettings: vi.fn(() => ({})),
    resolveLlmProvider: vi.fn(() => 'openai'),
}));

vi.mock('../../../src/constants.js', () => ({
    IMAGE_PORTRAIT_PRESETS: [],
}));

vi.mock('../../../src/utils/file-utils.js', () => ({
    getFileName: vi.fn((path) => path),
}));

vi.mock('../../../src/ui/folder-view.js', () => ({
    selectFileInList: vi.fn(),
    updateNewCardEntryVisibility: vi.fn(),
}));

vi.mock('../../../src/ui/preview.js', () => ({
    resetPreviewStage: vi.fn(),
    setPreviewFileInfo: vi.fn(),
    showPreviewImageDataUrl: vi.fn(),
}));

vi.mock('../../../src/ui/metadata-panel.js', () => ({
    setAdditionalInfoVisibility: vi.fn(),
    setFileInfoVisibility: vi.fn(),
}));

describe('card-editor detectSchemaVersion', () => {
    it('detects plain v1 payload shape as schema 1.0', async () => {
        const { detectSchemaVersion } = await import('../../../src/ui/card-editor.js');

        const schema = detectSchemaVersion({
            name: 'Test Character',
            description: 'Description',
            personality: 'Personality',
            scenario: 'Scenario',
            first_mes: 'Hello there',
            mes_example: '<START>Example message',
        });

        expect(schema).toBe('1.0');
    });

    it('still detects wrapped v2 and v3 schemas', async () => {
        const { detectSchemaVersion } = await import('../../../src/ui/card-editor.js');

        expect(detectSchemaVersion({ spec: 'chara_card_v2', spec_version: '2.0', data: {} })).toBe('2.0');
        expect(detectSchemaVersion({ spec: 'chara_card_v3', spec_version: '3.0', data: {} })).toBe('3.0');
    });

    it('recognizes wrapped card payloads as card-like after unwrapping', async () => {
        const { isCardLike, unwrapCardData } = await import('../../../src/ui/card-editor.js');
        const payload = {
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
                name: 'Unit Test Character',
                description: 'Test description',
                first_mes: 'Hello',
            },
        };

        expect(isCardLike(unwrapCardData(payload))).toBe(true);
    });

    it('rejects non-card JSON payloads', async () => {
        const { isCardLike } = await import('../../../src/ui/card-editor.js');
        expect(isCardLike({ foo: 'bar' })).toBe(false);
    });
});
