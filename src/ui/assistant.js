import { dom } from '../dom.js';
import {
    clearAssistantHistory,
    getAssistantHistory,
    getAssistantModelLabel,
    isAssistantConfigured,
    sendAssistantMessage,
} from '../services/assistant-service.js';

let isAssistantOpen = false;
let isAssistantSending = false;

/**
 * Returns true when assistant panel is currently visible.
 * @returns {boolean}
 */
export function isAssistantPanelOpen() {
    return isAssistantOpen;
}

/**
 * Escapes text content for safe HTML insertion in assistant message bubbles.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Updates assistant header model + connection indicators from current settings.
 */
function renderAssistantHeader() {
    if (dom.assistantModelInfo) {
        dom.assistantModelInfo.textContent = `Model: ${getAssistantModelLabel()}`;
    }

    const configured = isAssistantConfigured();
    if (dom.assistantConnectionStatus) {
        dom.assistantConnectionStatus.textContent = configured ? 'Ready' : 'Disconnected';
        dom.assistantConnectionStatus.classList.toggle('is-ready', configured);
    }
}

/**
 * Renders assistant message history into the panel scroll container.
 */
function renderAssistantMessages() {
    if (!dom.assistantMessages) {
        return;
    }

    const history = getAssistantHistory();
    if (history.length === 0) {
        dom.assistantMessages.innerHTML = '<div class="assistant-empty">Start a conversation with your configured LLM.</div>';
        return;
    }

    dom.assistantMessages.innerHTML = history.map((message) => {
        const role = message.role === 'user' ? 'user' : 'assistant';
        const label = role === 'user' ? 'You' : 'Assistant';
        return `<article class="assistant-message assistant-message-${role}">
            <header>${label}</header>
            <pre>${escapeHtml(message.content)}</pre>
        </article>`;
    }).join('');

    dom.assistantMessages.scrollTop = dom.assistantMessages.scrollHeight;
}

/**
 * Enables/disables assistant input controls while one request is in progress.
 */
function syncAssistantInputState() {
    if (dom.assistantSendBtn) {
        dom.assistantSendBtn.disabled = isAssistantSending;
        dom.assistantSendBtn.textContent = isAssistantSending ? 'Sending...' : 'Send';
    }
    if (dom.assistantInput) {
        dom.assistantInput.disabled = isAssistantSending;
    }
}

/**
 * Opens assistant panel and focuses input for immediate typing.
 */
function openAssistantPanel() {
    isAssistantOpen = true;
    if (dom.assistantPanel) {
        dom.assistantPanel.style.display = 'flex';
    }
    dom.assistantToggleBtn?.classList.add('is-active');
    renderAssistantHeader();
    renderAssistantMessages();
    dom.assistantInput?.focus();
}

/**
 * Closes assistant panel while preserving session conversation history.
 */
function closeAssistantPanel() {
    isAssistantOpen = false;
    if (dom.assistantPanel) {
        dom.assistantPanel.style.display = 'none';
    }
    dom.assistantToggleBtn?.classList.remove('is-active');
}

/**
 * Toggles assistant panel open/close state.
 */
function toggleAssistantPanel() {
    if (isAssistantOpen) {
        closeAssistantPanel();
    } else {
        openAssistantPanel();
    }
}

/**
 * Sends current assistant input content to LLM and appends returned answer.
 */
async function submitAssistantMessage() {
    if (isAssistantSending || !dom.assistantInput) {
        return;
    }

    const text = String(dom.assistantInput.value || '').trim();
    if (!text) {
        return;
    }

    isAssistantSending = true;
    syncAssistantInputState();

    try {
        await sendAssistantMessage(text);
        dom.assistantInput.value = '';
    } catch (error) {
        const message = String(error || 'Unknown assistant error');
        if (dom.assistantMessages) {
            dom.assistantMessages.insertAdjacentHTML(
                'beforeend',
                `<div class="assistant-error">${escapeHtml(message)}</div>`,
            );
            dom.assistantMessages.scrollTop = dom.assistantMessages.scrollHeight;
        }
    } finally {
        isAssistantSending = false;
        syncAssistantInputState();
        renderAssistantHeader();
        renderAssistantMessages();
        dom.assistantInput?.focus();
    }
}

/**
 * Initializes assistant UI events and global keyboard shortcuts.
 * Architectural context: panel is global to app shell and independent from active module.
 */
export function initAssistantUI() {
    renderAssistantHeader();
    renderAssistantMessages();
    syncAssistantInputState();

    dom.assistantToggleBtn?.addEventListener('click', () => {
        toggleAssistantPanel();
    });

    dom.assistantCloseBtn?.addEventListener('click', () => {
        closeAssistantPanel();
    });

    dom.assistantClearBtn?.addEventListener('click', () => {
        clearAssistantHistory();
        renderAssistantMessages();
        dom.assistantInput?.focus();
    });

    dom.assistantSendBtn?.addEventListener('click', async () => {
        await submitAssistantMessage();
    });

    dom.assistantInput?.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            await submitAssistantMessage();
        }
    });

    window.addEventListener('charbrowser:settings-saved', () => {
        renderAssistantHeader();
    });

    document.addEventListener('keydown', (event) => {
        const key = String(event.key || '').toLowerCase();
        if (event.ctrlKey && event.shiftKey && key === 'a') {
            event.preventDefault();
            toggleAssistantPanel();
            return;
        }

        if (key === 'escape' && isAssistantOpen) {
            event.preventDefault();
            closeAssistantPanel();
        }
    });
}
