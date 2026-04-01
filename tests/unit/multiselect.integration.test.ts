import { FormFiller } from '@/content/form-filler';

describe('FormFiller custom multiselect handling', () => {
  test('sets hidden input and updates display for .multiselect__single', async () => {
    document.body.innerHTML = `
      <div class="ms-widget">
        <span class="multiselect__single"></span>
        <input type="hidden" name="union" />
      </div>
    `;

    const filler = new FormFiller();
    const el = document.querySelector('.ms-widget') as HTMLElement;
    const field = {
      id: 'f1',
      selector: '.ms-widget',
      name: 'union',
      label: 'Union',
      value: 'AFLCIO',
      type: 'text',
    } as any;

    const ok = await filler.fillField(el, field);
    expect(ok).toBe(true);

    const hidden = document.querySelector('input[name="union"]') as HTMLInputElement;
    expect(hidden.value).toBe('AFLCIO');

    const display = document.querySelector('.multiselect__single') as HTMLElement;
    expect(display.textContent).toBe('AFLCIO');
  });
});
