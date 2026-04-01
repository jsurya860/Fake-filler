import type { FormAnalysis } from '@/shared/types';
import { FormDetectionEngine } from './form-detection';
import { FormFiller } from './form-filler';

// Lightweight safe-send wrapper for background messages
async function sendMessageSafe(msg: unknown): Promise<any> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return { success: false, error: 'no-runtime' };
    const res = await chrome.runtime.sendMessage(msg as any);
    return res ?? { success: false, error: 'no-response' };
  } catch {
    return { success: false, error: 'send-failed' };
  }
}

/**
 * Analyze a form by id, request generated values from the background,
 * then fill it using the existing FormFiller logic.
 * Returns the fill summary or null on failure.
 */
export async function fillFormById(id: string): Promise<{ filled: number; skipped: number } | null> {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el) {
    console.error('[FDF dev] form not found:', id);
    return null;
  }

  const detector = new FormDetectionEngine();
  const analysis = detector.analyzeForm(el);
  if (!analysis || !analysis.fields || analysis.fields.length === 0) {
    console.warn('[FDF dev] no fields detected for form:', id);
    return null;
  }

  // Ask background to generate values for the detected form.
  let genResp: any = null;
  try {
    genResp = await sendMessageSafe({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: analysis } });
  } catch (e) {
    console.debug('[FDF dev] generate request failed', e);
  }

  const enriched: FormAnalysis = (genResp && genResp.success && genResp.data) ? (genResp.data as FormAnalysis) : analysis;

  const filler = new FormFiller();
  const result = await filler.fillForm(enriched);
  console.info('[FDF dev] fill result for', id, result);
  return result;
}

// Expose a global helper for quick manual testing in the page console.
declare global {
  interface Window { FDF_devFillFormById?: (id: string) => Promise<any>; }
}
window.FDF_devFillFormById = fillFormById;

export default fillFormById;
