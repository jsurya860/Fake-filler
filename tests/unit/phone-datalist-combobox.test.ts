import { FormFiller } from '../../src/content/form-filler';

describe('Phone / Datalist / Combobox handling', () => {
  let filler: FormFiller;

  beforeEach(() => {
    document.body.innerHTML = '';
    filler = new FormFiller();
  });

  it('strips non-digits for tel inputs and respects minlength/maxlength', async () => {
    const input = document.createElement('input');
    input.type = 'tel';
    input.name = 'phone';
    input.setAttribute('minlength', '10');
    input.setAttribute('maxlength', '10');
    document.body.appendChild(input);

    const field: any = { id: 'f1', selector: 'input[name="phone"]', name: 'phone', label: 'Phone', type: 'phone', value: '340-899-5757' };
    const ok = await filler.fillField(input as HTMLElement, field);
    expect(ok).toBe(true);
    // value should be digits-only and length 10
    const v = (input as HTMLInputElement).value;
    expect(v).toMatch(/^\d{10}$/);
  });

  it('selects visible combobox option and sanitizes digits-only for phone-like inputs', async () => {
    // Build a simple react-select-like structure
    const wrapper = document.createElement('div');
    wrapper.className = 'react-select';
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'phone';
    wrapper.appendChild(input);

    const menu = document.createElement('div');
    menu.className = 'react-select__menu';
    const opt = document.createElement('div');
    opt.setAttribute('role', 'option');
    opt.textContent = '778-202-041';
    menu.appendChild(opt);
    wrapper.appendChild(menu);
    document.body.appendChild(wrapper);

    const field: any = { id: 'f2', selector: 'input[name="phone"]', name: 'phone', label: 'Phone', type: 'phone', value: '778202041' };
    const ok = await filler.fillField(input as HTMLElement, field);
    expect(ok).toBe(true);
    // After selection the input must contain digits-only
    const v = (input as HTMLInputElement).value;
    expect(v).toMatch(/^\d+$/);
  });
});
