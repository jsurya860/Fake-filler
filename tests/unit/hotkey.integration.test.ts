import fs from 'fs';
import path from 'path';
import { DataGenerator } from '../../src/background/data-generator';

describe('Hotkey integration', () => {
  beforeEach(() => {
    jest.resetModules();
    const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'all-inputs.html'), 'utf8');
    document.body.innerHTML = html;
  });

  it('triggers a fill when the configured hotkey is pressed', async () => {
    // Stub GET_SETTINGS to return a hotkey
    (global as any).chrome.runtime.sendMessage = jest.fn(async (msg: any) => {
      if (msg && msg.action === 'GET_SETTINGS') {
        return { success: true, data: { oneClickHotkey: 'ctrl+shift+f', domainWhitelist: [], domainBlacklist: [] } };
      }

      if (msg && msg.action === 'GENERATE_DATA_FOR_FORM') {
        // emulate background generation
        const form = msg.payload.formAnalysis;
        const gen = new DataGenerator({ locale: 'en-US', emailDomain: 'example.test' });
        const values = gen.generateForForm(form.fields, true);
        for (const fld of form.fields) {
          const v = values.get(fld.id);
          if (v !== undefined) fld.value = v;
        }
        return { success: true, data: form };
      }

      // Handle fire-and-forget messages (REPORT_DEBUG_LOG, REPORT_FILLED, etc.)
      return { success: true };
    });

    // Import content entry fresh (will register hotkey listener and run bootstrap)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/content/index');

    // Let the async bootstrap (shouldActivateOnCurrentDomain, refreshHotkeyFromSettings) settle
    await new Promise((r) => setTimeout(r, 500));

    // Simulate keydown for Ctrl+Shift+F (listener is on window)
    const ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true });
    window.dispatchEvent(ev);

    // Allow async fill handlers to complete
    await new Promise((r) => setTimeout(r, 1000));

    // Verify at least one field filled
    const email = document.querySelector<HTMLInputElement>('input[name="email"]');
    expect(email).not.toBeNull();
    expect(email!.value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  }, 15000);
});
