import type { ExtensionMessage, ExtensionResponse, FormAnalysis } from '@/shared/types';
import { FormDetectionEngine } from './form-detection';
import { FormFiller } from './form-filler';
import { sendMessageSafe, logSwallowed } from '@/shared/messaging';

/**
 * Analyze a form by id, request generated values from the background,
 * then fill it using the existing FormFiller logic.
 * Returns the fill summary or null on failure.
 */
export async function fillFormById(id: string): Promise<{ filled: number; skipped: number } | null> {
  const el = document.getElementById(id);
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
  let genResp: ExtensionResponse<FormAnalysis> | null = null;
  try {
    genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse<FormAnalysis>>({
      action: 'GENERATE_DATA_FOR_FORM',
      payload: { formAnalysis: analysis },
    });
  } catch (e) {
    logSwallowed('src/content/dev-fill-helper.ts: generate request failed', e);
  }

  const enriched: FormAnalysis = (genResp && genResp.success && genResp.data) ? genResp.data : analysis;

  const filler = new FormFiller();
  const result = await filler.fillForm(enriched);
  console.info('[FDF dev] fill result for', id, result);
  return result;
}

// Expose a global helper for quick manual testing in the page console.
// Gated to dev builds only — never attach a debug hook to a shipped bundle
// injected into every page.
declare global {
  interface Window { FDF_devFillFormById?: typeof fillFormById; }
}
// Vite replaces `process.env.NODE_ENV` with a literal string at build time
// (its default esbuild `define`), so the check compiles away to nothing —
// or a plain `false` guard — in a production bundle rather than leaving a
// runtime dependency on Node's `process` global inside the page.
if (process.env.NODE_ENV !== 'production') {
  window.FDF_devFillFormById = fillFormById;
}

export default fillFormById;
