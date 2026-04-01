import { FormDetectionEngine } from './src/content/form-detection';
import ModalDetectionEngine from './src/content/modal-detection';
import type { ModalAnalysis } from './src/content/modal-detection';

// =============================================================
// Integration Example: Form + Modal Detection
// =============================================================

class AutoFillController {
  private formDetector: FormDetectionEngine;
  private modalDetector: ModalDetectionEngine;

  constructor() {
    this.formDetector = new FormDetectionEngine();
    this.modalDetector = new ModalDetectionEngine();
  }

  /**
   * Initialize detection and start watching for modals
   */
  init() {
    console.log('[AutoFill] Initializing detection...');

    // Detect forms on initial page load
    this.detectAndLogForms();

    // Re-scan forms when DOM changes (for SPAs, lazy-loading, etc.)
    const observer = new MutationObserver(() => {
      this.detectAndLogForms();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Detect and log all forms on the page
   */
  private detectAndLogForms() {
    const forms = this.formDetector.detectForms();
    console.log(`[AutoFill] Found ${forms.length} form(s):`, forms);

    // Send to background script / popup
    chrome.runtime.sendMessage({
      type: 'FORMS_DETECTED',
      forms,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle modal-related logic (e.g., auto-fill forms inside modals)
   */
  private handleModalPopup(modals: ModalAnalysis[]) {
    for (const modal of modals) {
      console.log(`[AutoFill] Modal detected: "${modal.title}"`);

      // If modal contains a form, detect and fill it
      if (modal.hasForm) {
        console.log(`[AutoFill] Modal contains a form, attempting detection...`);

        // Find form inside modal
        const modalEl = document.querySelector(modal.selector);
        if (modalEl) {
          const forms = modalEl.querySelectorAll('form, [role="form"]');
          console.log(`[AutoFill] Found ${forms.length} form(s) inside modal`);

          // You can auto-fill these forms here
        }
      }
    }
  }

  /**
   * Detect active modal and return forms within it
   */
  getActiveModalForms() {
    const activeModal = this.modalDetector.detectActiveModal();
    if (!activeModal) return [];

    const modalEl = document.querySelector(activeModal.selector);
    if (!modalEl) return [];

    const forms = Array.from(
      modalEl.querySelectorAll<HTMLElement>('form, [role="form"]')
    );

    return forms.map((form) => this.formDetector.analyzeForm(form));
  }

  /**
   * Check for modals and handle them
   */
  checkModals() {
    const modals = this.modalDetector.detectModals();
    if (modals.length > 0) {
      this.handleModalPopup(modals);
    }
  }
}

// =============================================================
// Usage in Content Script
// =============================================================

// Initialize on page load
const controller = new AutoFillController();
controller.init();

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_ACTIVE_MODAL') {
    const modal = controller.checkModals();
    sendResponse({ modal });
  } else if (request.type === 'GET_FORMS_IN_MODAL') {
    const forms = controller.getActiveModalForms();
    sendResponse({ forms });
  }
});

export { AutoFillController };
