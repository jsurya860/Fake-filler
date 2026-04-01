import fillFormById from '../../src/content/dev-fill-helper';
import { FormDetectionEngine } from '../../src/content/form-detection';
import type { FormAnalysis, FieldAnalysis } from '../../src/shared/types';

beforeEach(() => {
  // Simple form fixture with a text and a telephone-like field
  document.body.innerHTML = `
    <form id="testForm">
      <div>
        <label for="firstName">First Name</label>
        <input id="firstName" name="firstName" placeholder="First Name" type="text">
      </div>
      <div>
        <label for="userNumber">Mobile</label>
        <input id="userNumber" name="userNumber" placeholder="Mobile Number" minlength="10" maxlength="10" type="text">
      </div>
      <button type="submit" id="submit">Submit</button>
    </form>
  `;
});

test('dev helper fills simple form fields using generated analysis', async () => {
  const formEl = document.getElementById('testForm') as HTMLElement;
  const detector = new FormDetectionEngine();
  const analysis = detector.analyzeForm(formEl);
  expect(analysis).toBeDefined();
  expect(analysis.fields.length).toBeGreaterThanOrEqual(1);

  // Create enriched analysis with deterministic values
  const enriched: FormAnalysis = { ...analysis };
  enriched.fields = enriched.fields.map((f: FieldAnalysis, i: number) => ({
    ...f,
    value: (f.type === 'phone' || /phone|mobile|tel/i.test(f.label || f.name || '')) ? '5551234567' : `Test${i}`,
  }));

  // Mock chrome.runtime.sendMessage to return the enriched analysis
  // @ts-ignore - add global mock
  (global as any).chrome = { runtime: { id: 'mock-id', sendMessage: jest.fn().mockResolvedValue({ success: true, data: enriched }) } };

  const result = await fillFormById('testForm');
  expect(result).not.toBeNull();
  expect(result!.filled).toBeGreaterThanOrEqual(1);

  // Verify DOM values were set
  const first = document.querySelector<HTMLInputElement>('#firstName');
  expect(first).toBeTruthy();
  expect(first!.value).toBeTruthy();

  const phone = document.querySelector<HTMLInputElement>('#userNumber');
  expect(phone).toBeTruthy();
  // Should be digits-only and respect maxlength=10
  expect((phone!.value || '').replace(/\D/g, '').length).toBeGreaterThanOrEqual(10);
});
