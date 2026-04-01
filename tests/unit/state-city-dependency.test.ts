import { FormFiller } from '../../src/content/form-filler';

describe('Dependent state->city comboboxes', () => {
  let filler: FormFiller;

  beforeEach(() => {
    document.body.innerHTML = '';
    filler = new FormFiller();
  });

  it('fills city after state enables it (multi-pass)', async () => {
    // Label covering both
    const label = document.createElement('label');
    label.id = 'stateCity-label';
    label.className = 'form-label';
    label.textContent = 'State and City';
    document.body.appendChild(label);

    // State combobox (react-select like)
    const stateWrapper = document.createElement('div');
    stateWrapper.className = 'react-select css-b62m3t-container';
    const stateInput = document.createElement('input');
    stateInput.type = 'text';
    stateInput.id = 'react-select-3-input';
    stateInput.setAttribute('role', 'combobox');
    stateWrapper.appendChild(stateInput);

    const stateMenu = document.createElement('div');
    stateMenu.className = 'react-select__menu';
    const stateOpt = document.createElement('div');
    stateOpt.setAttribute('role', 'option');
    stateOpt.textContent = 'California';
    stateMenu.appendChild(stateOpt);
    stateWrapper.appendChild(stateMenu);
    document.body.appendChild(stateWrapper);

    // City combobox, initially disabled
    const cityWrapper = document.createElement('div');
    cityWrapper.className = 'react-select css-3iigni-container';
    const cityInput = document.createElement('input');
    cityInput.type = 'text';
    cityInput.id = 'react-select-4-input';
    cityInput.setAttribute('role', 'combobox');
    cityInput.disabled = true;
    cityWrapper.appendChild(cityInput);
    const cityMenu = document.createElement('div');
    cityMenu.className = 'react-select__menu';
    cityWrapper.appendChild(cityMenu);
    document.body.appendChild(cityWrapper);

    // Clicking the state option enables the city input and injects city options
    stateOpt.addEventListener('click', () => {
      cityInput.disabled = false;
      // populate city options
      cityMenu.innerHTML = '';
      const c = document.createElement('div');
      c.setAttribute('role', 'option');
      c.textContent = 'San Francisco';
      cityMenu.appendChild(c);
    });

    const formAnalysis: any = {
      fields: [
        { id: 'state', selector: '#react-select-3-input', name: 'state', label: 'State', type: 'select', value: 'California' },
        { id: 'city', selector: '#react-select-4-input', name: 'city', label: 'City', type: 'select', value: 'San Francisco' },
      ],
    };

    // Fill state first, simulate the click enabling city, then fill city
    const sOk = await filler.fillField(stateInput as HTMLElement, formAnalysis.fields[0]);
    expect(sOk).toBe(true);
    // clicking state option should enable city
    expect((cityInput as HTMLInputElement).disabled).toBe(false);
    const cOk = await filler.fillField(cityInput as HTMLElement, formAnalysis.fields[1]);
    expect(cOk).toBe(true);
    expect((stateInput as HTMLInputElement).value || '').toBeTruthy();
    expect(((cityInput as HTMLInputElement).value ?? '').length).toBeGreaterThan(0);
  });
});
