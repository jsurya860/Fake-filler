export interface ModalAnalysis {
  id: string;
  selector: string;
  isVisible: boolean;
  hasForm: boolean;
  zIndex?: number;
  title?: string;
}

function uid(prefix = 'm'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function safeGetZIndex(el: HTMLElement): number | undefined {
  try {
    const z = getComputedStyle(el).zIndex;
    const n = Number(z);
    return isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

function isVisible(el: HTMLElement): boolean {
  try {
    if (el.hasAttribute('hidden')) return false;
    const cs = getComputedStyle(el);
    if (!cs) return true;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return false;
    return true;
  } catch {
    return true;
  }
}

export class ModalDetectionEngine {
  private readonly SELECTORS = [
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    // Specific framework/modal classes (avoid broad [class*=] wildcards)
    '.modal.show',
    '.modal.in',
    '.modal.active',
    '.modal.open',
    '.modal.visible',
    '.modal.is-open',
    '.modal.is-active',
    '.MuiDialog-root',
    '.MuiModal-root',
    '.ant-modal-wrap:not([style*="display: none"])',
    '.chakra-modal__content-container',
    '.ui.modal.active',
    '.ui.modal.visible',
    // YouTube buy-flow / payments
    '#buyFlowDivId',
    '.modal-dialog.b3-modal-dialog',
    '.b3-modal-dialog',
  ];

  detectModals(): ModalAnalysis[] {
    const seen = new WeakSet<Element>();
    const results: ModalAnalysis[] = [];
    for (const sel of this.SELECTORS) {
      try {
        document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          if (!isVisible(el)) return;
          const selector = el.id ? `#${CSS.escape(el.id)}` : this.cssSelector(el);
          results.push({
            id: uid('mdl'),
            selector,
            isVisible: true,
            hasForm: !!el.querySelector('input, textarea, select, form'),
            zIndex: safeGetZIndex(el),
            title: (el.querySelector('[class*="title"], h1, h2, h3')?.textContent || undefined)?.trim(),
          });
        });
      } catch { /* ignore bad selectors */ }
    }

    // also look for high z-index elements that look like overlays
    try {
      document.querySelectorAll<HTMLElement>('[style*="z-index"]').forEach((el) => {
        if (seen.has(el)) return;
        const z = safeGetZIndex(el) ?? 0;
        if (z > 999 && isVisible(el)) {
          seen.add(el);
          const selector = el.id ? `#${CSS.escape(el.id)}` : this.cssSelector(el);
          results.push({ id: uid('mdl'), selector, isVisible: true, hasForm: !!el.querySelector('input, textarea, select, form'), zIndex: z });
        }
      });
    } catch {}

    return results;
  }

  detectActiveModal(): ModalAnalysis | null {
    const mods = this.detectModals().filter((m) => m.isVisible);
    if (mods.length === 0) return null;
    mods.sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
    return mods[0];
  }

  private cssSelector(el: Element): string {
    try {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.body) {
        let sel = node.tagName.toLowerCase();
        if ((node as HTMLElement).className) {
          const cls = String((node as HTMLElement).className).split(/\s+/)[0];
          if (cls) sel += `.${CSS.escape(cls)}`;
        }
        parts.unshift(sel);
        node = node.parentElement;
      }
      return parts.join(' > ');
    } catch {
      return el.tagName.toLowerCase();
    }
  }
}

export default ModalDetectionEngine;
