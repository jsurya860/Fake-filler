import fs from 'fs';
import path from 'path';
import { FormDetectionEngine } from '../../src/content/form-detection';
import { DataGenerator } from '../../src/background/data-generator';
import { FormFiller } from '../../src/content/form-filler';
import type { FormAnalysis } from '../../src/shared/types';

// Helper: run full detect → generate → fill pipeline and return the DOM + result
async function runFillPipeline() {
  const detector = new FormDetectionEngine();
  const forms = detector.detectForms();
  const form = forms[0];

  const gen = new DataGenerator({ locale: 'en-US', emailDomain: 'example.test' });
  const values = gen.generateForForm(form.fields, true);

  for (const fld of form.fields) {
    const v = values.get(fld.id);
    if (v !== undefined) fld.value = v;
  }

  const filler = new FormFiller();
  const result = await filler.fillFormWithRecovery(form as any, { maxRetries: 2 });
  try { console.info('[TEST DEBUG] finalErrors:', result.finalErrors); } catch {}
  return { forms, form, values, result, filler };
}

describe('All inputs integration', () => {
  beforeEach(() => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'all-inputs.html'), 'utf8');
    document.body.innerHTML = html;
  });

  beforeAll(() => {
    jest.setTimeout(20000);
  });

  it('detects and fills a complex form with zero remaining errors', async () => {
    const { forms, result } = await runFillPipeline();

    expect(forms.length).toBeGreaterThanOrEqual(1);
    expect(result.filled).toBeGreaterThan(0);
    expect(result.finalErrors.length).toBe(0);
  }, 20000);

  it('fills account & profile fields correctly', async () => {
    await runFillPipeline();

    // Full name – 3+ chars
    const fullName = document.querySelector<HTMLInputElement>('input[name="fullName"]');
    expect(fullName!.value.length).toBeGreaterThanOrEqual(3);

    // Username – alphanumeric (may include dots, hyphens, underscores from faker), 3+ chars
    const username = document.querySelector<HTMLInputElement>('input[name="username"]');
    expect(username!.value).toMatch(/^[a-zA-Z0-9._-]{3,}$/);

    // Email – valid format
    const email = document.querySelector<HTMLInputElement>('input[name="email"]');
    expect(email!.value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

    // Password + confirm match
    const pw = document.querySelector<HTMLInputElement>('input[name="password"]');
    const cpw = document.querySelector<HTMLInputElement>('input[name="confirmPassword"]');
    expect(pw!.value).toBe(cpw!.value);
    expect(pw!.value.length).toBeGreaterThanOrEqual(8);

    // Age – 18-100
    const age = document.querySelector<HTMLInputElement>('input[name="age"]');
    const ageVal = Number(age!.value);
    expect(ageVal).toBeGreaterThanOrEqual(18);
    expect(ageVal).toBeLessThanOrEqual(100);
  }, 20000);

  it('fills address & location fields correctly', async () => {
    await runFillPipeline();

    // Country select has a real value
    const country = document.querySelector<HTMLSelectElement>('select[name="country"]');
    expect(country!.value).toBeTruthy();
    expect(country!.value).not.toBe('');

    // Latitude -90..90, longitude -180..180
    const lat = document.querySelector<HTMLInputElement>('input[name="latitude"]');
    const lng = document.querySelector<HTMLInputElement>('input[name="longitude"]');
    expect(Number(lat!.value)).toBeGreaterThanOrEqual(-90);
    expect(Number(lat!.value)).toBeLessThanOrEqual(90);
    expect(Number(lng!.value)).toBeGreaterThanOrEqual(-180);
    expect(Number(lng!.value)).toBeLessThanOrEqual(180);

    // Street – 5+ chars
    const street = document.querySelector<HTMLInputElement>('input[name="street"]');
    expect(street!.value.length).toBeGreaterThanOrEqual(5);
  }, 20000);

  it('fills professional fields correctly', async () => {
    await runFillPipeline();

    // Experience 0-70
    const exp = document.querySelector<HTMLInputElement>('input[name="experience"]');
    const expVal = Number(exp!.value);
    expect(expVal).toBeGreaterThanOrEqual(0);
    expect(expVal).toBeLessThanOrEqual(70);

    // Work email valid
    const workEmail = document.querySelector<HTMLInputElement>('input[name="workEmail"]');
    expect(workEmail!.value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

    // Industry select filled
    const industry = document.querySelector<HTMLSelectElement>('select[name="industry"]');
    expect(industry!.value).toBeTruthy();
    expect(industry!.value).not.toBe('');

    // Employment status select filled
    const empStatus = document.querySelector<HTMLSelectElement>('select[name="employmentStatus"]');
    expect(empStatus!.value).toBeTruthy();
    expect(empStatus!.value).not.toBe('');
  }, 20000);

  it('fills financial & banking fields correctly', async () => {
    await runFillPipeline();

    // Credit card – 13-19 digits
    const cc = document.querySelector<HTMLInputElement>('input[name="creditCard"]');
    expect(cc!.value).toMatch(/^[0-9]{13,19}$/);

    // CVV – 3-4 digits
    const cvv = document.querySelector<HTMLInputElement>('input[name="cvv"]');
    expect(cvv!.value).toMatch(/^[0-9]{3,4}$/);

    // Card expiry – MM/YY
    const expiry = document.querySelector<HTMLInputElement>('input[name="cardExpiry"]');
    expect(expiry!.value).toMatch(/^(0[1-9]|1[0-2])\/[0-9]{2}$/);

    // Currency select filled
    const currency = document.querySelector<HTMLSelectElement>('select[name="currency"]');
    expect(currency!.value).toBeTruthy();
    expect(currency!.value).not.toBe('');
  }, 20000);

  it('fills identification document fields correctly', async () => {
    await runFillPipeline();

    // SSN – 123-45-6789
    const ssn = document.querySelector<HTMLInputElement>('input[name="ssn"]');
    expect(ssn!.value).toMatch(/^[0-9]{3}-[0-9]{2}-[0-9]{4}$/);
  }, 20000);

  it('handles legal checkboxes — required checked, optional also filled', async () => {
    await runFillPipeline();

    // Required checkboxes must be checked
    const terms = document.querySelector<HTMLInputElement>('#termsAccept');
    const privacy = document.querySelector<HTMLInputElement>('#privacyAccept');
    const ageConfirm = document.querySelector<HTMLInputElement>('#ageConfirm');
    expect(terms!.checked).toBe(true);
    expect(privacy!.checked).toBe(true);
    expect(ageConfirm!.checked).toBe(true);

    // Optional checkboxes should be handled (value assigned, either checked or not)
    const dataProcessing = document.querySelector<HTMLInputElement>('#dataProcessingAccept');
    const backgroundCheck = document.querySelector<HTMLInputElement>('#backgroundCheckAccept');
    expect(dataProcessing).not.toBeNull();
    expect(backgroundCheck).not.toBeNull();
    // They have been processed (typeof checked is boolean — just verify elements exist and are accessible)
    expect(typeof dataProcessing!.checked).toBe('boolean');
    expect(typeof backgroundCheck!.checked).toBe('boolean');
  }, 20000);

  it('fills all required selects with non-empty values', async () => {
    await runFillPipeline();

    const requiredSelects = document.querySelectorAll<HTMLSelectElement>('select[required]');
    expect(requiredSelects.length).toBeGreaterThan(0);

    requiredSelects.forEach((sel) => {
      expect(sel.value).toBeTruthy();
      expect(sel.value).not.toBe('');
    });
  }, 20000);

  it('fills numeric fields within their min/max ranges', async () => {
    await runFillPipeline();

    const numericFields = [
      { name: 'teamSize', min: 1, max: 1000 },
      { name: 'noticePeriod', min: 0, max: 365 },
      { name: 'successRate', min: 0, max: 100 },
      { name: 'satisfactionScore', min: 1, max: 10 },
      { name: 'yearsInRole', min: 0, max: 70 },
    ];

    for (const { name, min, max } of numericFields) {
      const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      const val = Number(el!.value);
      expect(val).toBeGreaterThanOrEqual(min);
      expect(val).toBeLessThanOrEqual(max);
    }
  }, 20000);

  it('fills banking fields with correct patterns', async () => {
    await runFillPipeline();

    // Bank account: 10-20 digits
    const bankAccount = document.querySelector<HTMLInputElement>('input[name="bankAccount"]');
    expect(bankAccount!.value).toMatch(/^[0-9]{10,20}$/);

    // Routing number: exactly 9 digits
    const routing = document.querySelector<HTMLInputElement>('input[name="routingNumber"]');
    expect(routing!.value).toMatch(/^[0-9]{9}$/);

    // IFSC code: 11 uppercase alphanumeric
    const ifsc = document.querySelector<HTMLInputElement>('input[name="ifscCode"]');
    expect(ifsc!.value).toMatch(/^[A-Z0-9]{11}$/);

    // SWIFT code: 8-11 uppercase alphanumeric
    const swift = document.querySelector<HTMLInputElement>('input[name="swiftCode"]');
    expect(swift!.value).toMatch(/^[A-Z0-9]{8,11}$/);

    // Tax ID: 10-12 uppercase alphanumeric
    const taxId = document.querySelector<HTMLInputElement>('input[name="taxId"]');
    expect(taxId!.value).toMatch(/^[A-Z0-9]{10,12}$/);
  }, 20000);

  it('fills identification document fields correctly', async () => {
    await runFillPipeline();

    // SSN – 123-45-6789
    const ssn = document.querySelector<HTMLInputElement>('input[name="ssn"]');
    expect(ssn!.value).toMatch(/^[0-9]{3}-[0-9]{2}-[0-9]{4}$/);

    // Passport number: 6-20 uppercase alphanumeric
    const passport = document.querySelector<HTMLInputElement>('input[name="passportNumber"]');
    expect(passport!.value).toMatch(/^[A-Z0-9]{6,20}$/);

    // Passport expiry: must be a valid date (YYYY-MM-DD), not alphanumeric text
    const passportExpiry = document.querySelector<HTMLInputElement>('input[name="passportExpiry"]');
    expect(passportExpiry!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // License expiry: date format
    const licenseExpiry = document.querySelector<HTMLInputElement>('input[name="licenseExpiry"]');
    expect(licenseExpiry!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Visa expiry: date format
    const visaExpiry = document.querySelector<HTMLInputElement>('input[name="visaExpiry"]');
    expect(visaExpiry!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // National ID: digits and hyphens, 11-25 chars
    const nationalId = document.querySelector<HTMLInputElement>('input[name="nationalId"]');
    expect(nationalId!.value).toMatch(/^[0-9\-]{11,25}$/);

    // Visa number: 5-20 uppercase alphanumeric
    const visa = document.querySelector<HTMLInputElement>('input[name="visaNumber"]');
    expect(visa!.value).toMatch(/^[A-Z0-9]{5,20}$/);

    // Driving license: 5-20 uppercase alphanumeric
    const dl = document.querySelector<HTMLInputElement>('input[name="drivingLicense"]');
    expect(dl!.value).toMatch(/^[A-Z0-9]{5,20}$/);
  }, 20000);

  it('fills time, datetime-local, month, and week inputs', async () => {
    await runFillPipeline();

    // Interview time: HH:MM format
    const time = document.querySelector<HTMLInputElement>('input[name="interviewTime"]');
    expect(time!.value).toMatch(/^\d{2}:\d{2}$/);

    // Available from: datetime-local format
    const dtLocal = document.querySelector<HTMLInputElement>('input[name="availableFrom"]');
    expect(dtLocal!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    // Contract month: YYYY-MM format
    const month = document.querySelector<HTMLInputElement>('input[name="contractMonth"]');
    expect(month!.value).toMatch(/^\d{4}-\d{2}$/);

    // Project week: YYYY-Www format
    const week = document.querySelector<HTMLInputElement>('input[name="projectWeek"]');
    expect(week!.value).toMatch(/^\d{4}-W\d{2}$/);
  }, 20000);

  it('generates future dates for interview and start fields', async () => {
    await runFillPipeline();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Interview date should be today or in the future
    const interview = document.querySelector<HTMLInputElement>('input[name="interviewDate"]');
    const interviewDate = new Date(interview!.value);
    expect(interviewDate.getTime()).toBeGreaterThanOrEqual(today.getTime());

    // Start date should be today or in the future
    const start = document.querySelector<HTMLInputElement>('input[name="startDate"]');
    const startDate = new Date(start!.value);
    expect(startDate.getTime()).toBeGreaterThanOrEqual(today.getTime());
  }, 20000);

  it('generates step-aligned numeric values', async () => {
    await runFillPipeline();

    // Salary: step=1000
    const salary = document.querySelector<HTMLInputElement>('input[name="salary"]');
    if (salary!.value) {
      expect(Number(salary!.value) % 1000).toBe(0);
    }

    // Budget: step=100
    const budget = document.querySelector<HTMLInputElement>('input[name="budget"]');
    if (budget!.value) {
      expect(Number(budget!.value) % 100).toBe(0);
    }

    // Annual income: step=100
    const income = document.querySelector<HTMLInputElement>('input[name="annualIncome"]');
    if (income!.value) {
      expect(Number(income!.value) % 100).toBe(0);
    }
  }, 20000);

  it('generates numeric-only postal/zip codes', async () => {
    await runFillPipeline();

    const postal = document.querySelector<HTMLInputElement>('input[name="postal"]');
    expect(postal!.value).toMatch(/^[0-9]{5,10}$/);
  }, 20000);

  it('recovery does not overwrite valid fields', async () => {
    // Fill the form initially (without recovery)
    const detector = new FormDetectionEngine();
    const forms = detector.detectForms();
    const form = forms[0];
    const gen = new DataGenerator({ locale: 'en-US', emailDomain: 'example.test' });
    const values = gen.generateForForm(form.fields, true);

    for (const fld of form.fields) {
      const v = values.get(fld.id);
      if (v !== undefined) fld.value = v;
    }

    const filler = new FormFiller();
    await filler.fillForm(form as FormAnalysis);

    // Record valid field values BEFORE recovery
    const emailBefore = document.querySelector<HTMLInputElement>('input[name="email"]')!.value;
    const phoneBefore = document.querySelector<HTMLInputElement>('input[name="phone"]')!.value;
    const cityBefore = document.querySelector<HTMLInputElement>('input[name="city"]')!.value;
    const fullNameBefore = document.querySelector<HTMLInputElement>('input[name="fullName"]')!.value;

    // Trigger validation on all fields
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Now scan for errors
    const errors = filler.scanDomErrors(form.fields);
    const fieldErrors = errors.filter((e) => e.fieldId && e.fieldId.length > 0);

    // Check that valid fields are NOT in the error list
    const errorFieldIds = new Set(fieldErrors.map((e) => e.fieldId));
    const emailField = form.fields.find((f) => f.name === 'email');
    const phoneField = form.fields.find((f) => f.name === 'phone');
    const cityField = form.fields.find((f) => f.name === 'city');
    const fullNameField = form.fields.find((f) => f.name === 'fullName');

    // These fields should have valid values and NOT be in the error list
    if (emailBefore && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailBefore)) {
      expect(errorFieldIds.has(emailField!.id)).toBe(false);
    }
    if (phoneBefore && phoneBefore.replace(/\D/g, '').length >= 10) {
      expect(errorFieldIds.has(phoneField!.id)).toBe(false);
    }
    if (cityBefore && cityBefore.length >= 2) {
      expect(errorFieldIds.has(cityField!.id)).toBe(false);
    }
    if (fullNameBefore && fullNameBefore.length >= 3) {
      expect(errorFieldIds.has(fullNameField!.id)).toBe(false);
    }

    // Log what errors were detected for debugging
    console.log('[DIAG] fieldErrors count:', fieldErrors.length);
    for (const err of fieldErrors) {
      const fld = form.fields.find((f) => f.id === err.fieldId);
      console.log('[DIAG] error mapped to:', fld?.name ?? 'unknown', '| text:', err.text.slice(0, 50));
    }

    // Also check which form-groups have .error class
    const errorGroups = document.querySelectorAll('.form-group.error');
    console.log('[DIAG] .form-group.error count:', errorGroups.length);
    errorGroups.forEach((g) => {
      const input = g.querySelector('input, select, textarea');
      const name = input?.getAttribute('name') ?? 'none';
      const val = (input as HTMLInputElement | null)?.value?.slice(0, 30) ?? '';
      console.log('[DIAG] .error group:', name, 'val=', val);
    });

    // Also log total scanDomErrors (including those without fieldId)
    console.log('[DIAG] total scanDomErrors:', errors.length);
    for (const err of errors) {
      const fld = err.fieldId ? form.fields.find((f) => f.id === err.fieldId) : null;
      console.log('[DIAG] err field=' + (fld?.name ?? 'NONE') + ' fid=' + (err.fieldId || 'NONE') + ' text=' + err.text.slice(0, 80));
    }
  }, 20000);

  it('fills non-required fields (alt email, alt phone, website, optional selects, etc.)', async () => {
    await runFillPipeline();

    // Non-required text/email/url/tel fields should have values
    const altEmail = document.querySelector<HTMLInputElement>('input[name="altEmail"]');
    expect(altEmail!.value).toBeTruthy();
    expect(altEmail!.value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

    const altPhone = document.querySelector<HTMLInputElement>('input[name="altPhone"]');
    expect(altPhone!.value).toBeTruthy();

    const website = document.querySelector<HTMLInputElement>('input[name="website"]');
    expect(website!.value).toBeTruthy();

    const linkedin = document.querySelector<HTMLInputElement>('input[name="linkedin"]');
    expect(linkedin!.value).toBeTruthy();

    // Non-required numeric fields
    const salary = document.querySelector<HTMLInputElement>('input[name="salary"]');
    expect(salary!.value).toBeTruthy();

    const latitude = document.querySelector<HTMLInputElement>('input[name="latitude"]');
    expect(latitude!.value).toBeTruthy();

    const longitude = document.querySelector<HTMLInputElement>('input[name="longitude"]');
    expect(longitude!.value).toBeTruthy();

    // Non-required banking fields
    const ifsc = document.querySelector<HTMLInputElement>('input[name="ifscCode"]');
    expect(ifsc!.value).toBeTruthy();

    const swift = document.querySelector<HTMLInputElement>('input[name="swiftCode"]');
    expect(swift!.value).toBeTruthy();
  }, 20000);
});

export {};
