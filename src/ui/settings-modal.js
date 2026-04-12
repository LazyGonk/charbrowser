import { dom } from '../dom.js';
import { setStatus } from './card-editor.js';
import { fetchAvailableModels } from '../services/llm-service.js';
import { testComfyConnection, validateWorkflowJson } from '../services/comfyui-service.js';
import {
    DEFAULT_SETTINGS,
    LLM_API_ENDPOINTS,
    getAppDataPathCached,
    inferLlmEndpointPreset,
    loadSettings,
    resolveLlmProvider,
    saveSettings,
} from '../services/settings-service.js';

let activeSettingsTab = 'general';
let settingsDirty = false;
let lastSavedSettingsSnapshot = '{}';
const SETTINGS_FIELDS = [
    'settingsDarkMode',
    'settingsShowHiddenFiles',
    'settingsAutoLoadMetadata',
    'settingsShowThumbnails',
    'settingsDefaultCardFormat',
    'settingsPreviewQuality',
    'settingsLlmApiType',
    'settingsLlmApiEndpoint',
    'settingsLlmEndpoint',
    'settingsLlmApiKey',
    'settingsLlmModel',
    'settingsLlmTemperature',
    'settingsLlmMaxTokens',
    'settingsLlmSystemPrompt',
    'settingsPromptTemplateName',
    'settingsPromptTemplateDescription',
    'settingsPromptTemplateFirstMes',
    'settingsPromptTemplateCreatorNotes',
    'settingsPromptTemplateScenario',
    'settingsPromptTemplateTags',
    'settingsPromptTemplateVisualDesc',
    'settingsPromptTemplateGenerateAll',
    'settingsPromptTemplateLorebookGenerate',
    'settingsPromptTemplateLorebookRefine',
    'settingsComfyApiType',
    'settingsComfyEndpoint',
    'settingsComfyApiKey',
    'settingsComfyEndpointId',
    'settingsComfyWorkflow',
    'settingsComfyPositivePrompt',
    'settingsComfyNegativePrompt',
    'settingsAutoSaveCards',
    'settingsBackupInterval',
];

/**
 * Reads all settings form values from DOM inputs.
 */
function readSettingsForm() {
    return {
        darkMode: Boolean(dom.settingsDarkMode?.checked),
        showHiddenFiles: Boolean(dom.settingsShowHiddenFiles?.checked),
        autoLoadMetadata: Boolean(dom.settingsAutoLoadMetadata?.checked),
        showThumbnails: Boolean(dom.settingsShowThumbnails?.checked),
        autoSaveCards: Boolean(dom.settingsAutoSaveCards?.checked),
        backupInterval: Number(dom.settingsBackupInterval?.value || 60),
        defaultCardFormat: String(dom.settingsDefaultCardFormat?.value || '3.0'),
        previewQuality: String(dom.settingsPreviewQuality?.value || 'balanced'),
        llmApiType: String(dom.settingsLlmApiType?.value || 'openai'),
        llmApiEndpoint: String(dom.settingsLlmApiEndpoint?.value || 'custom'),
        llmEndpoint: String(dom.settingsLlmEndpoint?.value || '').trim(),
        llmApiKey: String(dom.settingsLlmApiKey?.value || '').trim(),
        llmModel: String(dom.settingsLlmModel?.value || '').trim(),
        llmTemperature: Number(dom.settingsLlmTemperature?.value || 0.7),
        llmMaxTokens: Number(dom.settingsLlmMaxTokens?.value || 1024),
        llmSystemPrompt: String(dom.settingsLlmSystemPrompt?.value || '').trim(),
        promptTemplateName: String(dom.settingsPromptTemplateName?.value || '').trim(),
        promptTemplateDescription: String(dom.settingsPromptTemplateDescription?.value || '').trim(),
        promptTemplateFirstMes: String(dom.settingsPromptTemplateFirstMes?.value || '').trim(),
        promptTemplateCreatorNotes: String(dom.settingsPromptTemplateCreatorNotes?.value || '').trim(),
        promptTemplateScenario: String(dom.settingsPromptTemplateScenario?.value || '').trim(),
        promptTemplateTags: String(dom.settingsPromptTemplateTags?.value || '').trim(),
        promptTemplateVisualDesc: String(dom.settingsPromptTemplateVisualDesc?.value || '').trim(),
        promptTemplateGenerateAll: String(dom.settingsPromptTemplateGenerateAll?.value || '').trim(),
        promptTemplateCharacterBookGenerate: String(dom.settingsPromptTemplateLorebookGenerate?.value || '').trim(),
        promptTemplateCharacterBookRefine: String(dom.settingsPromptTemplateLorebookRefine?.value || '').trim(),
        // Keep legacy keys for backward compatibility.
        promptTemplateLorebookGenerate: String(dom.settingsPromptTemplateLorebookGenerate?.value || '').trim(),
        promptTemplateLorebookRefine: String(dom.settingsPromptTemplateLorebookRefine?.value || '').trim(),
        comfyApiType: dom.settingsComfyApiType?.value === 'runpod' ? 'runpod' : 'local',
        comfyEndpoint: String(dom.settingsComfyEndpoint?.value || '').trim(),
        comfyApiKey: String(dom.settingsComfyApiKey?.value || '').trim(),
        comfyEndpointId: String(dom.settingsComfyEndpointId?.value || '').trim(),
        comfyWorkflow: String(dom.settingsComfyWorkflow?.value || '').trim(),
        comfyPositivePrompt: String(dom.settingsComfyPositivePrompt?.value || '').trim(),
        comfyNegativePrompt: String(dom.settingsComfyNegativePrompt?.value || '').trim(),
    };
}

/**
 * Writes one settings object into the settings form controls.
 * @param {ReturnType<typeof readSettingsForm>} settings
 */
function applySettingsForm(settings) {
    if (dom.settingsDarkMode) dom.settingsDarkMode.checked = Boolean(settings.darkMode);
    if (dom.settingsShowHiddenFiles) dom.settingsShowHiddenFiles.checked = Boolean(settings.showHiddenFiles);
    if (dom.settingsAutoLoadMetadata) dom.settingsAutoLoadMetadata.checked = Boolean(settings.autoLoadMetadata);
    if (dom.settingsShowThumbnails) dom.settingsShowThumbnails.checked = Boolean(settings.showThumbnails);
    if (dom.settingsAutoSaveCards) dom.settingsAutoSaveCards.checked = Boolean(settings.autoSaveCards);
    if (dom.settingsBackupInterval) dom.settingsBackupInterval.value = String(settings.backupInterval || 60);
    if (dom.settingsDefaultCardFormat) dom.settingsDefaultCardFormat.value = settings.defaultCardFormat || '3.0';
    if (dom.settingsPreviewQuality) dom.settingsPreviewQuality.value = settings.previewQuality || 'balanced';
    if (dom.settingsLlmApiType) dom.settingsLlmApiType.value = settings.llmApiType === 'ollama' ? 'ollama' : 'openai';
    renderLlmEndpointOptions(
        settings.llmApiType === 'ollama' ? 'ollama' : 'openai',
        settings.llmApiEndpoint || inferLlmEndpointPreset(settings.llmApiType, settings.llmEndpoint)
    );
    if (dom.settingsLlmEndpoint) dom.settingsLlmEndpoint.value = settings.llmEndpoint || '';
    if (dom.settingsLlmApiKey) dom.settingsLlmApiKey.value = settings.llmApiKey || '';
    if (dom.settingsLlmModel) dom.settingsLlmModel.value = settings.llmModel || '';
    if (dom.settingsLlmTemperature) dom.settingsLlmTemperature.value = String(settings.llmTemperature ?? 0.7);
    if (dom.settingsLlmMaxTokens) dom.settingsLlmMaxTokens.value = String(settings.llmMaxTokens ?? 1024);
    if (dom.settingsLlmSystemPrompt) dom.settingsLlmSystemPrompt.value = settings.llmSystemPrompt || '';
    if (dom.settingsPromptTemplateName) dom.settingsPromptTemplateName.value = settings.promptTemplateName || '';
    if (dom.settingsPromptTemplateDescription) dom.settingsPromptTemplateDescription.value = settings.promptTemplateDescription || '';
    if (dom.settingsPromptTemplateFirstMes) dom.settingsPromptTemplateFirstMes.value = settings.promptTemplateFirstMes || '';
    if (dom.settingsPromptTemplateCreatorNotes) dom.settingsPromptTemplateCreatorNotes.value = settings.promptTemplateCreatorNotes || '';
    if (dom.settingsPromptTemplateScenario) dom.settingsPromptTemplateScenario.value = settings.promptTemplateScenario || '';
    if (dom.settingsPromptTemplateTags) dom.settingsPromptTemplateTags.value = settings.promptTemplateTags || '';
    if (dom.settingsPromptTemplateVisualDesc) dom.settingsPromptTemplateVisualDesc.value = settings.promptTemplateVisualDesc || '';
    if (dom.settingsPromptTemplateGenerateAll) dom.settingsPromptTemplateGenerateAll.value = settings.promptTemplateGenerateAll || '';
    if (dom.settingsPromptTemplateLorebookGenerate) {
        dom.settingsPromptTemplateLorebookGenerate.value = settings.promptTemplateCharacterBookGenerate || settings.promptTemplateLorebookGenerate || '';
    }
    if (dom.settingsPromptTemplateLorebookRefine) {
        dom.settingsPromptTemplateLorebookRefine.value = settings.promptTemplateCharacterBookRefine || settings.promptTemplateLorebookRefine || '';
    }
    if (dom.settingsComfyApiType) dom.settingsComfyApiType.value = settings.comfyApiType === 'runpod' ? 'runpod' : 'local';
    if (dom.settingsComfyEndpoint) dom.settingsComfyEndpoint.value = settings.comfyEndpoint || '';
    if (dom.settingsComfyApiKey) dom.settingsComfyApiKey.value = settings.comfyApiKey || '';
    if (dom.settingsComfyEndpointId) dom.settingsComfyEndpointId.value = settings.comfyEndpointId || '';
    if (dom.settingsComfyWorkflow) dom.settingsComfyWorkflow.value = settings.comfyWorkflow || '';
    if (dom.settingsComfyPositivePrompt) dom.settingsComfyPositivePrompt.value = settings.comfyPositivePrompt || '';
    if (dom.settingsComfyNegativePrompt) dom.settingsComfyNegativePrompt.value = settings.comfyNegativePrompt || '';
    syncLlmAuthState();
    syncComfyAuthState();
}

/**
 * Toggles ComfyUI settings fields based on selected API type.
 */
function syncComfyAuthState() {
    const isRunpod = dom.settingsComfyApiType?.value === 'runpod';
    if (dom.settingsComfyLocalFields) {
        dom.settingsComfyLocalFields.style.display = isRunpod ? 'none' : 'block';
    }
    if (dom.settingsComfyRunpodFields) {
        dom.settingsComfyRunpodFields.style.display = isRunpod ? 'block' : 'none';
    }
}

/**
 * Rebuilds endpoint preset selector based on API type selection.
 * @param {'openai'|'ollama'} apiType
 * @param {string} selectedValue
 */
function renderLlmEndpointOptions(apiType, selectedValue) {
    if (!dom.settingsLlmApiEndpoint) {
        return;
    }

    const options = apiType === 'ollama' ? LLM_API_ENDPOINTS.ollama : LLM_API_ENDPOINTS.openai;
    dom.settingsLlmApiEndpoint.innerHTML = '';

    for (const optionValue of options) {
        const option = document.createElement('option');
        option.value = optionValue.value;
        option.textContent = optionValue.label;
        if (optionValue.value === selectedValue) {
            option.selected = true;
        }
        dom.settingsLlmApiEndpoint.appendChild(option);
    }

    if (!dom.settingsLlmApiEndpoint.value && options.length > 0) {
        dom.settingsLlmApiEndpoint.value = options[0].value;
    }
}

/**
 * Applies selected endpoint preset default URL to endpoint input.
 * @param {boolean} force
 */
function applyEndpointPresetToInput(force = false) {
    const apiType = dom.settingsLlmApiType?.value === 'ollama' ? 'ollama' : 'openai';
    const preset = String(dom.settingsLlmApiEndpoint?.value || '');
    const config = (apiType === 'ollama' ? LLM_API_ENDPOINTS.ollama : LLM_API_ENDPOINTS.openai)
        .find((entry) => entry.value === preset);

    if (!config || !dom.settingsLlmEndpoint) {
        return;
    }

    if (force || !dom.settingsLlmEndpoint.value.trim()) {
        dom.settingsLlmEndpoint.value = config.endpoint;
    }
}

/**
 * Updates API key placeholder/disabled state according to selected provider.
 */
function syncLlmAuthState() {
    if (!dom.settingsLlmApiKey) {
        return;
    }

    const apiType = dom.settingsLlmApiType?.value === 'ollama' ? 'ollama' : 'openai';
    const presetValue = String(dom.settingsLlmApiEndpoint?.value || '');
    const options = apiType === 'ollama' ? LLM_API_ENDPOINTS.ollama : LLM_API_ENDPOINTS.openai;
    const preset = options.find((entry) => entry.value === presetValue);
    const needsAuth = Boolean(preset?.needsAuth);

    dom.settingsLlmApiKey.placeholder = needsAuth ? 'Required for selected provider (sk-...)' : 'Optional API key';
    dom.settingsLlmApiKey.disabled = apiType === 'ollama';
}

/**
 * Returns a stable JSON snapshot used for dirty-change comparisons.
 * @returns {string}
 */
function snapshotCurrentSettings() {
    return JSON.stringify(readSettingsForm());
}

/**
 * Rebuilds the model dropdown (datalist) from endpoint-discovered model IDs.
 * @param {string[]} modelIds
 * @param {string} selectedModel
 */
function renderModelOptions(modelIds, selectedModel) {
    if (!dom.settingsLlmModelSelect || !dom.settingsLlmModelList) {
        return;
    }

    // Update the datalist with model options
    dom.settingsLlmModelList.innerHTML = '';

    for (const modelId of modelIds) {
        const option = document.createElement('option');
        option.value = modelId;
        dom.settingsLlmModelList.appendChild(option);
    }

    // If a model is selected, ensure it's set in the input
    if (selectedModel && dom.settingsLlmModel) {
        dom.settingsLlmModel.value = selectedModel;
    }
}

/**
 * Refreshes available models from configured endpoint and updates model-related controls.
 */
async function refreshAvailableModels() {
    const endpoint = String(dom.settingsLlmEndpoint?.value || '').trim();
    const apiKey = String(dom.settingsLlmApiKey?.value || '').trim();
    const selectedModel = String(dom.settingsLlmModel?.value || '').trim();
    const provider = resolveLlmProvider(readSettingsForm());

    if (!endpoint) {
        renderModelOptions([], selectedModel);
        if (dom.settingsLlmModelsStatus) {
            dom.settingsLlmModelsStatus.textContent = 'Set endpoint first to discover models.';
        }
        return;
    }

    if (dom.settingsFetchModelsBtn) {
        dom.settingsFetchModelsBtn.disabled = true;
    }
    if (dom.settingsLlmModelsStatus) {
        dom.settingsLlmModelsStatus.textContent = 'Fetching models...';
    }

    try {
        const models = await fetchAvailableModels({ endpoint, apiKey, apiType: provider });
        renderModelOptions(models, selectedModel);
        if (dom.settingsLlmModelsStatus) {
            dom.settingsLlmModelsStatus.textContent = models.length > 0
                ? `Found ${models.length} model${models.length === 1 ? '' : 's'}.`
                : 'No models found. Check endpoint configuration.';
        }
    } catch (error) {
        renderModelOptions([], selectedModel);
        if (dom.settingsLlmModelsStatus) {
            dom.settingsLlmModelsStatus.textContent = `Model discovery failed: ${String(error)}`;
        }
    } finally {
        if (dom.settingsFetchModelsBtn) {
            dom.settingsFetchModelsBtn.disabled = false;
        }
    }
}

/**
 * Marks settings as having unsaved changes and highlights the save button.
 */
function markSettingsDirty() {
    settingsDirty = snapshotCurrentSettings() !== lastSavedSettingsSnapshot;
    if (dom.saveSettingsBtn) {
        dom.saveSettingsBtn.classList.toggle('btn-primary', settingsDirty);
        dom.saveSettingsBtn.classList.toggle('btn-secondary', !settingsDirty);
    }
}

/**
 * Scrolls to a confirmation bar and briefly highlights it to draw attention.
 * @param {HTMLElement | null} element
 */
function focusConfirmBar(element) {
    if (!element) {
        return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.remove('confirm-flash');
    void element.offsetWidth;
    element.classList.add('confirm-flash');
}

/**
 * Shows the inline unsaved-changes confirm bar inside the settings modal.
 */
function showSettingsCloseConfirm() {
    if (dom.settingsCloseConfirm) {
        dom.settingsCloseConfirm.style.display = 'flex';
        focusConfirmBar(dom.settingsCloseConfirm);
    }
}

/**
 * Hides the inline unsaved-changes confirm bar.
 */
function hideSettingsCloseConfirm() {
    if (dom.settingsCloseConfirm) {
        dom.settingsCloseConfirm.style.display = 'none';
    }
}

/**
 * Clears unsaved changes flag and restores save button to neutral state.
 */
function clearSettingsDirty() {
    settingsDirty = false;
    lastSavedSettingsSnapshot = snapshotCurrentSettings();
    if (dom.saveSettingsBtn) {
        dom.saveSettingsBtn.classList.remove('btn-primary');
        dom.saveSettingsBtn.classList.add('btn-secondary');
    }
    hideSettingsCloseConfirm();
}

/**
 * Resets LLM prompt template inputs to defaults.
 */
function resetPromptTemplatesToDefaults() {
    if (dom.settingsPromptTemplateName) dom.settingsPromptTemplateName.value = DEFAULT_SETTINGS.promptTemplateName;
    if (dom.settingsPromptTemplateDescription) dom.settingsPromptTemplateDescription.value = DEFAULT_SETTINGS.promptTemplateDescription;
    if (dom.settingsPromptTemplateFirstMes) dom.settingsPromptTemplateFirstMes.value = DEFAULT_SETTINGS.promptTemplateFirstMes;
    if (dom.settingsPromptTemplateCreatorNotes) dom.settingsPromptTemplateCreatorNotes.value = DEFAULT_SETTINGS.promptTemplateCreatorNotes;
    if (dom.settingsPromptTemplateScenario) dom.settingsPromptTemplateScenario.value = DEFAULT_SETTINGS.promptTemplateScenario;
    if (dom.settingsPromptTemplateTags) dom.settingsPromptTemplateTags.value = DEFAULT_SETTINGS.promptTemplateTags;
    if (dom.settingsPromptTemplateVisualDesc) dom.settingsPromptTemplateVisualDesc.value = DEFAULT_SETTINGS.promptTemplateVisualDesc;
    if (dom.settingsPromptTemplateGenerateAll) dom.settingsPromptTemplateGenerateAll.value = DEFAULT_SETTINGS.promptTemplateGenerateAll;
    if (dom.settingsPromptTemplateLorebookGenerate) dom.settingsPromptTemplateLorebookGenerate.value = DEFAULT_SETTINGS.promptTemplateCharacterBookGenerate;
    if (dom.settingsPromptTemplateLorebookRefine) dom.settingsPromptTemplateLorebookRefine.value = DEFAULT_SETTINGS.promptTemplateCharacterBookRefine;
    markSettingsDirty();
}

/**
 * Returns all settings tab button/panel pairs for shared modal logic.
 * Centralizing this mapping keeps tab switching declarative and easy to extend.
 * @returns {Array<{name: string, button: HTMLButtonElement | null, panel: HTMLElement | null}>}
 */
function getSettingsTabs() {
    return [
        { name: 'general', button: dom.settingsTabGeneral, panel: dom.settingsPanelGeneral },
        { name: 'llm', button: dom.settingsTabLlm, panel: dom.settingsPanelLlm },
        { name: 'comfy', button: dom.settingsTabComfy, panel: dom.settingsPanelComfy },
        { name: 'about', button: dom.settingsTabAbout, panel: dom.settingsPanelAbout },
    ];
}

/**
 * Applies active/inactive state across all settings tabs and panels.
 * @param {'general'|'llm'|'comfy'|'about'} tabName
 */
function setActiveSettingsTab(tabName) {
    activeSettingsTab = tabName;

    for (const tab of getSettingsTabs()) {
        const isActive = tab.name === tabName;
        tab.button?.classList.toggle('is-active', isActive);
        tab.button?.setAttribute('aria-selected', isActive ? 'true' : 'false');

        if (tab.panel) {
            tab.panel.classList.toggle('is-active', isActive);
            tab.panel.hidden = !isActive;
        }
    }
}

/**
 * Syncs dependent settings controls whose enabled state depends on other fields.
 * This stays UI-only for now and deliberately avoids persistence concerns.
 */
function syncSettingsFormState() {
    if (dom.settingsBackupInterval) {
        dom.settingsBackupInterval.disabled = !dom.settingsAutoSaveCards?.checked;
    }
}

/**
 * Opens the settings modal and optionally focuses a specific tab.
 * @param {'general'|'llm'|'comfy'|'about'} [tabName='general']
 */
export function openSettingsModal(tabName = 'general') {
    if (!dom.settingsModal) {
        return;
    }

    applySettingsForm(loadSettings());
    lastSavedSettingsSnapshot = snapshotCurrentSettings();
    settingsDirty = false;
    if (dom.saveSettingsBtn) {
        dom.saveSettingsBtn.classList.remove('btn-primary');
        dom.saveSettingsBtn.classList.add('btn-secondary');
    }
    hideSettingsCloseConfirm();
    if (dom.settingsAppDataPath) {
        const dataPath = getAppDataPathCached();
        dom.settingsAppDataPath.textContent = dataPath
            ? `App data file: ${dataPath}`
            : 'App data file: unavailable';
    }

    setActiveSettingsTab(tabName);
    syncSettingsFormState();
    dom.settingsModal.style.display = 'flex';

    if (tabName === 'llm') {
        void refreshAvailableModels();
    }
}

/**
 * Closes the settings modal, showing an inline confirm bar when there are unsaved changes.
 * A second close attempt while the bar is open treats the action as "keep editing".
 */
export function closeSettingsModal() {
    if (snapshotCurrentSettings() !== lastSavedSettingsSnapshot) {
        if (dom.settingsCloseConfirm?.style.display === 'flex') {
            hideSettingsCloseConfirm();
            return;
        }
        showSettingsCloseConfirm();
        return;
    }
    clearSettingsDirty();
    if (dom.settingsModal) {
        dom.settingsModal.style.display = 'none';
    }
}

/**
 * Wires toolbar/settings entry points and lightweight modal tab behavior.
 */
export function initSettingsModal() {
    if (!dom.settingsModal || !dom.openSettingsBtn) {
        return;
    }

    dom.openSettingsBtn.disabled = false;
    dom.openSettingsBtn.title = 'Open settings';
    if (dom.cardOpenLlmSettingsBtn) {
        dom.cardOpenLlmSettingsBtn.disabled = false;
        dom.cardOpenLlmSettingsBtn.title = 'Open LLM settings';
    }

    dom.openSettingsBtn.addEventListener('click', () => {
        openSettingsModal(activeSettingsTab);
    });

    dom.closeSettingsBtn?.addEventListener('click', () => {
        closeSettingsModal();
    });

    dom.saveSettingsBtn?.addEventListener('click', async () => {
        try {
            const settings = readSettingsForm();
            await saveSettings(settings);
            
            // Apply theme based on dark mode setting
            if (settings.darkMode) {
                document.body.classList.remove('light-mode');
            } else {
                document.body.classList.add('light-mode');
            }
            
            clearSettingsDirty();
            window.dispatchEvent(new CustomEvent('charbrowser:settings-saved'));
            setStatus('Settings saved.');
            closeSettingsModal();
        } catch (error) {
            setStatus(`Settings save failed: ${String(error)}`);
        }
    });

    dom.settingsSaveAndCloseBtn?.addEventListener('click', async () => {
        try {
            const settings = readSettingsForm();
            await saveSettings(settings);
            
            // Apply theme based on dark mode setting
            if (settings.darkMode) {
                document.body.classList.remove('light-mode');
            } else {
                document.body.classList.add('light-mode');
            }
            
            clearSettingsDirty();
            window.dispatchEvent(new CustomEvent('charbrowser:settings-saved'));
            setStatus('Settings saved.');
            if (dom.settingsModal) {
                dom.settingsModal.style.display = 'none';
            }
        } catch (error) {
            setStatus(`Settings save failed: ${String(error)}`);
        }
    });

    dom.settingsDiscardBtn?.addEventListener('click', () => {
        clearSettingsDirty();
        if (dom.settingsModal) {
            dom.settingsModal.style.display = 'none';
        }
    });

    dom.settingsCancelCloseBtn?.addEventListener('click', () => {
        hideSettingsCloseConfirm();
    });

    dom.settingsFetchModelsBtn?.addEventListener('click', () => {
        void refreshAvailableModels();
    });

    // When user selects from dropdown: copy to upper field, reset filter
    dom.settingsLlmModelSelect?.addEventListener('change', () => {
        if (dom.settingsLlmModel && dom.settingsLlmModelSelect) {
            const selectedValue = dom.settingsLlmModelSelect.value;
            if (selectedValue) {
                dom.settingsLlmModel.value = selectedValue;
                dom.settingsLlmModelSelect.value = ''; // Reset filter
                markSettingsDirty();
            }
        }
    });

    // When user types manually in filter: copy to upper field for immediate feedback
    dom.settingsLlmModelSelect?.addEventListener('input', () => {
        if (dom.settingsLlmModel && dom.settingsLlmModelSelect) {
            dom.settingsLlmModel.value = dom.settingsLlmModelSelect.value;
            markSettingsDirty();
        }
    });

    dom.settingsResetTemplatesBtn?.addEventListener('click', () => {
        resetPromptTemplatesToDefaults();
    });

    dom.settingsTestComfyConnectionBtn?.addEventListener('click', async () => {
        const comfyApiType = dom.settingsComfyApiType?.value === 'runpod' ? 'runpod' : 'local';
        const endpoint = String(dom.settingsComfyEndpoint?.value || '').trim();
        const apiKey = String(dom.settingsComfyApiKey?.value || '').trim();
        const endpointId = String(dom.settingsComfyEndpointId?.value || '').trim();
        const statusEl = dom.settingsComfyConnectionStatus;
        if (comfyApiType === 'local' && !endpoint) {
            if (statusEl) statusEl.textContent = 'Enter a local endpoint first.';
            return;
        }
        if (comfyApiType === 'runpod' && (!apiKey || !endpointId)) {
            if (statusEl) statusEl.textContent = 'Enter RunPod API key and endpoint ID first.';
            return;
        }
        if (statusEl) statusEl.textContent = 'Testing...';
        if (dom.settingsTestComfyConnectionBtn) dom.settingsTestComfyConnectionBtn.disabled = true;
        try {
            const msg = await testComfyConnection({
                comfyApiType,
                endpoint,
                apiKey,
                endpointId,
            });
            if (statusEl) statusEl.textContent = `✓ ${msg}`;
        } catch (error) {
            if (statusEl) statusEl.textContent = `✗ ${String(error)}`;
        } finally {
            if (dom.settingsTestComfyConnectionBtn) dom.settingsTestComfyConnectionBtn.disabled = false;
        }
    });

    dom.settingsComfyValidateWorkflowBtn?.addEventListener('click', () => {
        const workflowText = String(dom.settingsComfyWorkflow?.value || '');
        const statusEl = dom.settingsComfyWorkflowStatus;
        const result = validateWorkflowJson(workflowText);
        if (statusEl) {
            statusEl.textContent = result.valid ? `✓ ${result.message}` : `✗ ${result.message}`;
        }
    });

    dom.settingsLlmApiType?.addEventListener('change', () => {
        const apiType = dom.settingsLlmApiType?.value === 'ollama' ? 'ollama' : 'openai';
        const defaultPreset = apiType === 'ollama' ? 'local' : 'custom';
        renderLlmEndpointOptions(apiType, defaultPreset);
        applyEndpointPresetToInput(true);
        syncLlmAuthState();
        markSettingsDirty();
        void refreshAvailableModels();
    });

    dom.settingsLlmApiEndpoint?.addEventListener('change', () => {
        const selectedPreset = String(dom.settingsLlmApiEndpoint?.value || '');
        applyEndpointPresetToInput(selectedPreset !== 'custom');
        syncLlmAuthState();
        markSettingsDirty();
        void refreshAvailableModels();
    });

    dom.settingsComfyApiType?.addEventListener('change', () => {
        syncComfyAuthState();
        markSettingsDirty();
    });

    // Mark dirty on any settings input change.
    for (const fieldId of SETTINGS_FIELDS) {
        const el = document.getElementById(fieldId);
        el?.addEventListener('input', markSettingsDirty);
        el?.addEventListener('change', markSettingsDirty);
    }

    dom.settingsLlmEndpoint?.addEventListener('change', () => {
        const apiType = dom.settingsLlmApiType?.value === 'ollama' ? 'ollama' : 'openai';
        const inferred = inferLlmEndpointPreset(apiType, dom.settingsLlmEndpoint.value);
        renderLlmEndpointOptions(apiType, inferred);
        syncLlmAuthState();
        void refreshAvailableModels();
    });

    dom.settingsAutoSaveCards?.addEventListener('change', () => {
        syncSettingsFormState();
    });

    dom.cardOpenLlmSettingsBtn?.addEventListener('click', () => {
        openSettingsModal('llm');
    });

    for (const tab of getSettingsTabs()) {
        tab.button?.addEventListener('click', () => {
            setActiveSettingsTab(/** @type {'general'|'llm'|'comfy'|'about'} */ (tab.name));
            if (tab.name === 'llm') {
                void refreshAvailableModels();
            }
        });
    }

    dom.settingsModal.addEventListener('click', (event) => {
        if (event.target === dom.settingsModal) {
            closeSettingsModal();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && dom.settingsModal?.style.display === 'flex') {
            event.preventDefault();
            closeSettingsModal();
        }
    });

    syncSettingsFormState();
    applySettingsForm(loadSettings());
    syncComfyAuthState();
    lastSavedSettingsSnapshot = snapshotCurrentSettings();
    setActiveSettingsTab('general');
}