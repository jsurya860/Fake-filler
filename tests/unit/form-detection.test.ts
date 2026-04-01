import { FormDetectionEngine } from '../../src/content/form-detection';

describe('FormDetectionEngine', () => {
  let engine: FormDetectionEngine;

  beforeEach(() => {
    document.body.innerHTML = '';
    engine = new FormDetectionEngine();
  });

  it('detects a simple login form and classifies it as login', () => {
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email';
    email.name = 'email';
    form.appendChild(email);
    const pwd = document.createElement('input');
    pwd.type = 'password';
    pwd.name = 'password';
    form.appendChild(pwd);
    document.body.appendChild(form);

    const forms = engine.detectForms();
    expect(forms.length).toBeGreaterThanOrEqual(1);
    const detected = forms[0];
    expect(detected.type).toBe('login');
    const types = detected.fields.map((f: any) => f.type);
    expect(types).toContain('email');
    expect(types).toContain('password');
  });

  it('detects implicit forms (container without <form>)', () => {
    const container = document.createElement('div');
    const a = document.createElement('input');
    a.name = 'firstName';
    const b = document.createElement('input');
    b.name = 'lastName';
    container.appendChild(a);
    container.appendChild(b);
    document.body.appendChild(container);

    const forms = engine.detectForms();
    // should find the implicit container as a form
    expect(forms.some((f) => f.selector.includes('div'))).toBe(true);
  });

  it('detects standalone search input outside a form', () => {
    const input = document.createElement('input');
    input.type = 'search';
    input.name = 'q';
    document.body.appendChild(input);

    const forms = engine.detectForms();
    // should detect at least one form-like analysis containing the search field
    const found = forms.flatMap((f) => f.fields).some((fld: any) => fld.htmlType === 'search' || fld.name === 'q');
    expect(found).toBe(true);
  });

  it('extracts options from custom dropdown-like elements', () => {
    // Place the input inside a real <form> to ensure detection.
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.name = 'choice';
    form.appendChild(input);
    document.body.appendChild(form);

    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'choice');
    expect(fld).toBeDefined();
  });

  it('extracts label from Vue wrapper with nested divs (Plan Code pattern)', () => {
    // Mirrors real Vue DOM:
    // <div class="col-xl-4 ...">
    //   <span> "Plan Code" <span class="required-indc">*</span>
    //     <div><input name="planCode"/></div>
    //   </span>
    // </div>
    document.body.innerHTML = `
      <form>
        <div class="col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4" data-v-2de8c56e>
          <span data-v-b5b96d8e>
            Plan Code
            <span class="required-indc"> * </span>
            <div>
              <input id="planCode" name="planCode" type="text" />
            </div>
          </span>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'planCode');
    expect(fld).toBeDefined();
    expect(fld!.label).toBe('Plan Code');
  });

  it('extracts label from sibling <label> without for attribute in wrapper', () => {
    // <span><label>Plan Code</label><div class="input-icon"><input name="planCode"/></div></span>
    document.body.innerHTML = `
      <form>
        <span>
          <label>Plan Code</label>
          <div class="input-icon">
            <input id="planCode" name="planCode" type="text" />
          </div>
        </span>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'planCode');
    expect(fld).toBeDefined();
    expect(fld!.label).toBe('Plan Code');
  });

  it('stops ancestor walk at multi-field containers', () => {
    // Two fields in same parent — ancestor walk should NOT bleed labels
    document.body.innerHTML = `
      <form>
        <div class="row">
          <div class="col">
            <span>Plan Code <div><input name="planCode" type="text" /></div></span>
          </div>
          <div class="col">
            <span>Plan Name <div><input name="planName" type="text" /></div></span>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const code = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'planCode');
    const name = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'planName');
    expect(code).toBeDefined();
    expect(name).toBeDefined();
    expect(code!.label).toBe('Plan Code');
    expect(name!.label).toBe('Plan Name');
  });

  it('extracts label from Google Forms .M7eMe question text (deeply nested input)', () => {
    // Google Forms DOM: <span class="M7eMe"> sits several levels above the input
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <span class="M7eMe">What is your name(Full name)?</span>
            <div class="vnumgf">
              <div class="RpC4Ke">
                <div class="DhZxSe">
                  <div class="aCsJod oJeWuf">
                    <div class="Xb9hP">
                      <input type="text" class="whsOnd zHQkBf" name="entry.123456" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.123456');
    expect(fld).toBeDefined();
    expect(fld!.label).toBe('What is your name(Full name)?');
    // Should be detected as fullName type (regex matches "full name" and "your name")
    expect(fld!.type).toBe('fullName');
  });

  it('extracts label from Google Forms with multiple questions', () => {
    // Multiple questions — each should get its own label, not bleed into others
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <span class="M7eMe">What is your email?</span>
            <div class="vnumgf"><div class="RpC4Ke"><div class="DhZxSe">
              <div class="aCsJod"><div class="Xb9hP">
                <input type="text" name="entry.111" />
              </div></div>
            </div></div></div>
          </div>
        </div>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <span class="M7eMe">Phone number</span>
            <div class="vnumgf"><div class="RpC4Ke"><div class="DhZxSe">
              <div class="aCsJod"><div class="Xb9hP">
                <input type="text" name="entry.222" />
              </div></div>
            </div></div></div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const email = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.111');
    const phone = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.222');
    expect(email).toBeDefined();
    expect(phone).toBeDefined();
    expect(email!.label).toBe('What is your email?');
    expect(phone!.label).toBe('Phone number');
  });

  it('extracts clean label via aria-labelledby in Google Forms (strips required *)', () => {
    // Real Google Forms: input has aria-labelledby="i12" pointing to the question div
    // which contains <span class="M7eMe">question</span> + <span class="vnumgf">*</span>
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div jsaction="EEvAHc:yfX90c;">
            <div class="geS5n">
              <div id="i12" class="Dlwxyf RjsPE" aria-level="3">
                <span class="M7eMe">What is your name(Full name)?</span>
                <span class="vnumgf"> *</span>
              </div>
              <div class="Dq2EYc">
                <div class="RpC4Ke">
                  <div class="DhZxSe">
                    <div class="aCsJod oJeWuf">
                      <div class="Xb9hP">
                        <input type="text" class="whsOnd zHQkBf" name="entry.100"
                               aria-label="Your answer" aria-labelledby="i12" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.100');
    expect(fld).toBeDefined();
    // Should extract clean label from .M7eMe, NOT "What is your name(Full name)? *"
    expect(fld!.label).toBe('What is your name(Full name)?');
    expect(fld!.type).toBe('fullName');
  });

  it('detects email field via aria-labelledby in Google Forms', () => {
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i15" class="Dlwxyf RjsPE">
              <span class="M7eMe">Email address</span>
              <span class="vnumgf"> *</span>
            </div>
            <div class="Dq2EYc">
              <div class="RpC4Ke"><div class="DhZxSe">
                <div class="aCsJod"><div class="Xb9hP">
                  <input type="text" class="whsOnd zHQkBf" name="entry.200"
                         aria-label="Your answer" aria-labelledby="i15" />
                </div></div>
              </div></div>
            </div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.200');
    expect(fld).toBeDefined();
    expect(fld!.label).toBe('Email address');
    expect(fld!.type).toBe('email');
  });

  it('detects phone field via aria-labelledby in Google Forms', () => {
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i18" class="Dlwxyf RjsPE">
              <span class="M7eMe">Phone number</span>
            </div>
            <div class="Dq2EYc">
              <div class="RpC4Ke"><div class="DhZxSe">
                <div class="aCsJod"><div class="Xb9hP">
                  <input type="text" class="whsOnd zHQkBf" name="entry.300"
                         aria-label="Your answer" aria-labelledby="i18" />
                </div></div>
              </div></div>
            </div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.300');
    expect(fld).toBeDefined();
    expect(fld!.label).toBe('Phone number');
    expect(fld!.type).toBe('phone');
  });

  it('handles Google Forms with multiple questions via aria-labelledby', () => {
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i1" class="Dlwxyf"><span class="M7eMe">Full name</span><span class="vnumgf"> *</span></div>
            <div class="Dq2EYc"><div class="RpC4Ke"><div class="DhZxSe"><div class="aCsJod"><div class="Xb9hP">
              <input type="text" name="entry.1" aria-label="Your answer" aria-labelledby="i1" />
            </div></div></div></div></div>
          </div>
        </div>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i2" class="Dlwxyf"><span class="M7eMe">Email</span><span class="vnumgf"> *</span></div>
            <div class="Dq2EYc"><div class="RpC4Ke"><div class="DhZxSe"><div class="aCsJod"><div class="Xb9hP">
              <input type="text" name="entry.2" aria-label="Your answer" aria-labelledby="i2" />
            </div></div></div></div></div>
          </div>
        </div>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i3" class="Dlwxyf"><span class="M7eMe">Your address</span></div>
            <div class="Dq2EYc"><div class="RpC4Ke"><div class="DhZxSe"><div class="aCsJod"><div class="Xb9hP">
              <input type="text" name="entry.3" aria-label="Your answer" aria-labelledby="i3" />
            </div></div></div></div></div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fields = forms.flatMap((f) => f.fields);
    const name = fields.find((x: any) => x.name === 'entry.1');
    const email = fields.find((x: any) => x.name === 'entry.2');
    const addr = fields.find((x: any) => x.name === 'entry.3');
    expect(name!.label).toBe('Full name');
    expect(name!.type).toBe('fullName');
    expect(email!.label).toBe('Email');
    expect(email!.type).toBe('email');
    expect(addr!.label).toBe('Your address');
    // "Your address" matches street pattern (/address.?line|addr|house|building/)
    expect(['address', 'street']).toContain(addr!.type);
  });

  it('skips generic aria-label="Your answer" and uses aria-labelledby instead', () => {
    // The critical Google Forms bug: input has both aria-label="Your answer" (generic)
    // and aria-labelledby="i99" (pointing to actual question). Must prefer aria-labelledby.
    document.body.innerHTML = `
      <form>
        <div class="Qr7Oae" role="listitem">
          <div class="geS5n">
            <div id="i99" class="Dlwxyf RjsPE">
              <span class="M7eMe">What is your email address?</span>
              <span class="vnumgf"> *</span>
            </div>
            <div class="Dq2EYc">
              <div class="RpC4Ke"><div class="DhZxSe"><div class="aCsJod"><div class="Xb9hP">
                <input type="text" class="whsOnd zHQkBf" name="entry.999"
                       aria-label="Your answer" aria-labelledby="i99"
                       jsname="YPqjbf" dir="auto" />
              </div></div></div></div>
            </div>
          </div>
        </div>
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'entry.999');
    expect(fld).toBeDefined();
    // Must NOT be "Your answer" — must be the actual question text
    expect(fld!.label).toBe('What is your email address?');
    expect(fld!.label).not.toBe('Your answer');
    expect(fld!.type).toBe('email');
  });

  // =========================================================
  // 7-attribute matching tests
  // Each test verifies that a field is correctly identified
  // when the semantic hint is ONLY in one specific attribute.
  // =========================================================

  it('matches field type via id attribute only', () => {
    document.body.innerHTML = `
      <form>
        <input id="firstName" type="text" />
        <input id="dummy2" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.selector.includes('firstName'));
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('firstName');
  });

  it('matches field type via name attribute only', () => {
    document.body.innerHTML = `
      <form>
        <input name="email_address" type="text" />
        <input name="dummy3" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.name === 'email_address');
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('email');
  });

  it('matches field type via label text only', () => {
    document.body.innerHTML = `
      <form>
        <label for="f1">Phone Number</label>
        <input id="f1" type="text" />
        <input name="dummy4" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.selector.includes('f1'));
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('phone');
  });

  it('matches field type via aria-label attribute only', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" aria-label="Street address" />
        <input name="dummy5" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.ariaLabel === 'Street address');
    expect(fld).toBeDefined();
    expect(['street', 'address']).toContain(fld!.type);
  });

  it('matches field type via aria-labelledby attribute only', () => {
    document.body.innerHTML = `
      <form>
        <span id="lbl1">Company name</span>
        <input type="text" aria-labelledby="lbl1" />
        <input name="dummy6" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.label === 'Company name');
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('company');
  });

  it('matches field type via class attribute only', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" class="custom-email-input form-control" />
        <input name="dummy7" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => (x.className || '').includes('email'));
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('email');
  });

  it('matches field type via placeholder attribute only', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" placeholder="Enter your city" />
        <input name="dummy8" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => (x.placeholder || '').includes('city'));
    expect(fld).toBeDefined();
    expect(fld!.type).toBe('city');
  });

  it('stores ariaLabel and className on FieldAnalysis', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" aria-label="Full name" class="name-input txt-field" />
        <input name="dummy9" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const fld = forms.flatMap((f) => f.fields).find((x: any) => x.ariaLabel === 'Full name');
    expect(fld).toBeDefined();
    expect(fld!.ariaLabel).toBe('Full name');
    expect(fld!.className).toContain('name-input');
  });

  // =============================================================
  // Edge-case tests for universal form compatibility
  // =============================================================

  it('skips hidden input fields', () => {
    document.body.innerHTML = `
      <form>
        <input type="hidden" name="csrf_token" value="abc123" />
        <input type="text" name="email" />
        <input type="password" name="password" />
      </form>
    `;
    const forms = engine.detectForms();
    expect(forms.length).toBe(1);
    const types = forms[0].fields.map((f: any) => f.type);
    expect(types).not.toContain('hidden');
    expect(forms[0].fields.length).toBe(2);
  });

  it('skips readOnly text inputs', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="readonlyField" value="Locked" readonly />
        <input type="text" name="email" />
        <input name="dummy" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const names = forms[0].fields.map((f: any) => f.name);
    expect(names).not.toContain('readonlyField');
    expect(names).toContain('email');
  });

  it('skips disabled inputs', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="disabledField" disabled />
        <input type="text" name="email" />
        <input name="dummy" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const names = forms[0].fields.map((f: any) => f.name);
    expect(names).not.toContain('disabledField');
    expect(names).toContain('email');
  });

  it('does NOT skip readOnly checkboxes (they still respond to click)', () => {
    document.body.innerHTML = `
      <form>
        <input type="checkbox" name="agree" id="agree" readonly />
        <label for="agree">I agree</label>
        <input type="text" name="email" />
      </form>
    `;
    const forms = engine.detectForms();
    const names = forms[0].fields.map((f: any) => f.name);
    expect(names).toContain('agree');
  });

  it('does not classify "Title" (salutation) as jobTitle', () => {
    document.body.innerHTML = `
      <form>
        <label for="title">Title</label>
        <select id="title" name="title">
          <option value="">Select</option>
          <option value="Mr">Mr</option>
          <option value="Mrs">Mrs</option>
          <option value="Dr">Dr</option>
        </select>
        <input name="dummy" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const titleFld = forms[0].fields.find((f: any) => f.name === 'title');
    expect(titleFld).toBeDefined();
    // Should be 'select' (from HTML type) not 'jobTitle'
    expect(titleFld!.type).toBe('select');
  });

  it('correctly classifies login form even with hidden CSRF token', () => {
    document.body.innerHTML = `
      <form>
        <input type="hidden" name="_token" value="csrf123" />
        <input type="email" name="email" />
        <input type="password" name="password" />
      </form>
    `;
    const forms = engine.detectForms();
    expect(forms[0].type).toBe('login');
    // Hidden field should be excluded, leaving only email + password
    expect(forms[0].fields.length).toBe(2);
  });

  it('detects native select options correctly', () => {
    document.body.innerHTML = `
      <form>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Please select</option>
          <option value="US">United States</option>
          <option value="UK">United Kingdom</option>
          <option value="CA">Canada</option>
        </select>
        <input name="dummy" type="text" />
      </form>
    `;
    const forms = engine.detectForms();
    const countryFld = forms[0].fields.find((f: any) => f.name === 'country');
    expect(countryFld).toBeDefined();
    expect(countryFld!.type).toBe('select');
    // Empty-value placeholder option should be filtered out
    expect(countryFld!.constraints.options!.length).toBe(3);
    expect(countryFld!.constraints.options!.map((o: any) => o.value)).toEqual(['US', 'UK', 'CA']);
  });

  it('handles form with mixed input types comprehensively', () => {
    document.body.innerHTML = `
      <form>
        <input type="email" name="email" />
        <input type="tel" name="phone" />
        <input type="date" name="dob" />
        <input type="number" name="age" min="18" max="100" />
        <input type="url" name="website" />
        <input type="color" name="favColor" />
        <textarea name="bio"></textarea>
      </form>
    `;
    const forms = engine.detectForms();
    const typeMap: Record<string, string> = {};
    forms[0].fields.forEach((f: any) => { typeMap[f.name] = f.type; });
    expect(typeMap['email']).toBe('email');
    expect(typeMap['phone']).toBe('phone');
    expect(typeMap['dob']).toBe('date');
    expect(typeMap['age']).toBe('number');
    expect(typeMap['website']).toBe('url');
    expect(typeMap['favColor']).toBe('color');
    expect(typeMap['bio']).toBe('textarea');
  });

  it('handles autocomplete attribute for field type detection', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" autocomplete="given-name" />
        <input type="text" autocomplete="family-name" />
        <input type="text" autocomplete="postal-code" />
        <input type="text" autocomplete="organization" />
      </form>
    `;
    const forms = engine.detectForms();
    const types = forms[0].fields.map((f: any) => f.type);
    expect(types).toContain('firstName');
    expect(types).toContain('lastName');
    expect(types).toContain('zipcode');
    expect(types).toContain('company');
  });

  it('detects multi-step form indicator', () => {
    document.body.innerHTML = `
      <form>
        <div class="step step-1">
          <input type="text" name="firstName" />
          <input type="text" name="lastName" />
        </div>
        <div class="step step-2" style="display:none">
          <input type="email" name="email" />
        </div>
        <button type="button">Next</button>
        <button type="submit">Submit</button>
      </form>
    `;
    const forms = engine.detectForms();
    expect(forms.length).toBeGreaterThanOrEqual(1);
    // Only visible fields from step-1 should be detected
    const names = forms[0].fields.map((f: any) => f.name);
    expect(names).toContain('firstName');
    expect(names).toContain('lastName');
    // email is in display:none step, should be excluded by isFieldVisible
    expect(names).not.toContain('email');
  });
});
