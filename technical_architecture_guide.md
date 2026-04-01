# Advanced Fake Data Filler Extension - Technical Architecture

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│              Browser Extension                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌────────────────────────────────────────────────┐   │
│  │ Content Script (Injected into Web Pages)       │   │
│  ├────────────────────────────────────────────────┤   │
│  │ • Form Detection Engine                        │   │
│  │ • Field Analysis (ML + Rule-based)            │   │
│  │ • User Interaction Handler                     │   │
│  │ • Error Detection & Recovery                   │   │
│  └────────────────────────────────────────────────┘   │
│                        ↕ Message Passing              │
│  ┌────────────────────────────────────────────────┐   │
│  │ Background Service Worker                      │   │
│  ├────────────────────────────────────────────────┤   │
│  │ • Data Generation Engine                       │   │
│  │ • Profile Management (Local Storage)           │   │
│  │ • Encryption/Decryption                        │   │
│  │ • Error Analysis & Learning                    │   │
│  │ • Validation Rules Engine                      │   │
│  └────────────────────────────────────────────────┘   │
│                        ↕ Message Passing              │
│  ┌────────────────────────────────────────────────┐   │
│  │ Popup UI (React/Vue)                           │   │
│  ├────────────────────────────────────────────────┤   │
│  │ • Form Preview & Editing                       │   │
│  │ • Profile Selection                            │   │
│  │ • Settings Panel                               │   │
│  │ • Status Display                               │   │
│  └────────────────────────────────────────────────┘   │
│                                                         │
│  ┌────────────────────────────────────────────────┐   │
│  │ Local Storage (Encrypted)                      │   │
│  ├────────────────────────────────────────────────┤   │
│  │ • User Profiles                                │   │
│  │ • Settings & Preferences                       │   │
│  │ • Error Learning Database                      │   │
│  │ • Domain Whitelist/Blacklist                   │   │
│  └────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Form Detection Engine (Content Script)

**File:** `content-script.js`

```javascript
class FormDetectionEngine {
  constructor() {
    this.forms = [];
    this.fields = [];
    this.observers = [];
  }

  // Scan page for forms
  detectForms() {
    const forms = document.querySelectorAll('form, [role="form"]');
    const untaggedForms = this.detectImplicitForms();
    return Array.from(forms).concat(untaggedForms);
  }

  // Detect forms not wrapped in <form> tags
  detectImplicitForms() {
    const inputs = document.querySelectorAll('input, textarea, select');
    const clusters = this.clusterRelatedInputs(inputs);
    return clusters.map(cluster => ({
      type: 'implicit',
      fields: cluster,
      submitButton: this.findNearestButton(cluster)
    }));
  }

  // Analyze each field
  analyzeField(field) {
    return {
      type: this.detectFieldType(field),      // email, phone, name, etc.
      constraints: this.extractConstraints(field), // min, max, pattern
      label: this.findLabel(field),
      placeholder: field.placeholder,
      required: field.required || this.detectRequired(field),
      validation: this.parseValidation(field),
      errorMsg: this.findErrorMessage(field),
      position: field.getBoundingClientRect(),
      element: field // Reference for later filling
    };
  }

  // Machine Learning: Field Type Detection
  detectFieldType(field) {
    // Priority: HTML5 type > Regex analysis > ML model > Default to text
    
    const htmlType = field.type?.toLowerCase();
    if (['email', 'tel', 'number', 'date', 'password', 'url'].includes(htmlType)) {
      return htmlType;
    }

    // Regex-based fallback
    const name = (field.name || '').toLowerCase();
    const id = (field.id || '').toLowerCase();
    const label = (this.findLabel(field) || '').toLowerCase();
    const placeholder = (field.placeholder || '').toLowerCase();
    
    const patterns = {
      email: /email|e-mail|mail|address/i,
      phone: /phone|tel|mobile|contact|number/i,
      name: /^name|first.?name|last.?name|full.?name|surname/i,
      password: /password|pwd|secret|pass/i,
      date: /date|dob|birth|anniversary|registered|joined/i,
      address: /address|street|avenue|road|lane|city|state|zip|postal/i,
      zipcode: /zip|postal|postcode|code/i,
      // ... more patterns
    };

    for (const [type, regex] of Object.entries(patterns)) {
      if (regex.test(name + label + placeholder + id)) {
        return type;
      }
    }

    // ML Model (TensorFlow.js) as fallback
    const features = this.extractFieldFeatures(field);
    const prediction = this.mlModel.predict(features);
    return prediction.type;
  }

  // Extract constraints from HTML5 attributes
  extractConstraints(field) {
    return {
      minLength: field.minLength || null,
      maxLength: field.maxLength || null,
      min: field.min || null,
      max: field.max || null,
      pattern: field.pattern || null,
      step: field.step || null,
      required: field.required,
      readOnly: field.readOnly,
      disabled: field.disabled,
      multiple: field.multiple,
      accept: field.accept, // for file inputs
    };
  }

  // Watch for dynamic field changes
  observeFormChanges(form) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
          const newFields = mutation.addedNodes.querySelectorAll('input, select, textarea');
          newFields.forEach(field => this.analyzeField(field));
        }
      }
    });

    observer.observe(form, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['name', 'id', 'type', 'placeholder', 'required']
    });

    return observer;
  }
}
```

---

### 2. Data Generation Engine (Background Service Worker)

**File:** `background/data-generator.js`

```javascript
class DataGenerator {
  constructor(locale = 'en-US') {
    this.locale = locale;
    this.faker = new Faker({ locale });
    this.validationCache = new Map();
  }

  // Generate data for a field
  generateForField(fieldAnalysis, constraints = {}) {
    const { type, validation } = fieldAnalysis;
    
    let data;
    switch (type) {
      case 'email':
        data = this.generateEmail(constraints);
        break;
      case 'phone':
        data = this.generatePhone(constraints);
        break;
      case 'name':
        data = this.generateName(constraints);
        break;
      case 'date':
        data = this.generateDate(constraints);
        break;
      case 'password':
        data = this.generatePassword(validation);
        break;
      case 'creditcard':
        data = this.generateCreditCard(validation);
        break;
      case 'address':
        data = this.generateAddress(constraints);
        break;
      case 'number':
        data = this.generateNumber(constraints);
        break;
      default:
        data = this.generateText(constraints);
    }

    // Validate against constraints
    if (!this.validateData(data, fieldAnalysis)) {
      data = this.regenerate(fieldAnalysis, constraints);
    }

    return data;
  }

  // Email generation
  generateEmail(constraints = {}) {
    const domain = constraints.domain || 'testdomain.com';
    const firstName = this.faker.person.firstName().toLowerCase();
    const lastName = this.faker.person.lastName().toLowerCase();
    const timestamp = Date.now();
    
    return `${firstName}.${lastName}+${timestamp}@${domain}`;
  }

  // Phone generation with locale support
  generatePhone(constraints = {}) {
    const formats = {
      'en-US': '(555) ###-####',      // 555 exchange for US
      'en-GB': '020 #### ####',        // London format
      'de-DE': '+49 30 ########',      // Berlin format
      'fr-FR': '+33 1 ## ## ## ##',   // Paris format
      'ja-JP': '090-####-####',        // Mobile format
    };

    const format = formats[this.locale] || formats['en-US'];
    let phone = format.replace(/#/g, () => Math.floor(Math.random() * 10));

    // Validate length
    const minLength = constraints.minLength || 10;
    const maxLength = constraints.maxLength || 15;
    
    while (phone.replace(/\D/g, '').length < minLength) {
      phone += Math.floor(Math.random() * 10);
    }

    return phone.slice(0, maxLength);
  }

  // Password generation with complexity rules
  generatePassword(validationRules = {}) {
    const length = validationRules.minLength || 12;
    const hasUpper = validationRules.requireUppercase !== false;
    const hasLower = validationRules.requireLowercase !== false;
    const hasNumber = validationRules.requireNumber !== false;
    const hasSpecial = validationRules.requireSpecial !== false;

    let password = '';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    if (hasUpper) password += upper[Math.floor(Math.random() * upper.length)];
    if (hasLower) password += lower[Math.floor(Math.random() * lower.length)];
    if (hasNumber) password += numbers[Math.floor(Math.random() * numbers.length)];
    if (hasSpecial) password += special[Math.floor(Math.random() * special.length)];

    const allChars = (hasUpper ? upper : '') + 
                     (hasLower ? lower : '') + 
                     (hasNumber ? numbers : '') + 
                     (hasSpecial ? special : '');

    while (password.length < length) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    return password.split('').sort(() => Math.random() - 0.5).join('');
  }

  // Credit card generation (test cards)
  generateCreditCard(constraints = {}) {
    const testCards = {
      visa: '4111111111111111',
      mastercard: '5555555555554444',
      amex: '378282246310005',
      discover: '6011111111111117'
    };

    const cardType = constraints.cardType || 'visa';
    const card = testCards[cardType] || testCards.visa;
    
    // Add expiry
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const year = String(new Date().getFullYear() + Math.floor(Math.random() * 5) + 1).slice(2);
    const cvv = String(Math.floor(Math.random() * 999) + 100);

    return {
      number: card,
      expiry: `${month}/${year}`,
      cvv: cvv
    };
  }

  // Validate generated data
  validateData(data, fieldAnalysis) {
    const { constraints, validation } = fieldAnalysis;

    if (constraints.minLength && data.length < constraints.minLength) {
      return false;
    }
    if (constraints.maxLength && data.length > constraints.maxLength) {
      return false;
    }
    if (constraints.pattern) {
      const regex = new RegExp(constraints.pattern);
      if (!regex.test(data)) return false;
    }

    // Custom validation rules
    if (validation?.type === 'email') {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data);
    }
    if (validation?.type === 'phone') {
      return /\d{10,15}/.test(data.replace(/\D/g, ''));
    }

    return true;
  }

  // Regenerate if validation fails
  regenerate(fieldAnalysis, constraints = {}, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      const data = this.generateForField(fieldAnalysis, constraints);
      if (this.validateData(data, fieldAnalysis)) {
        return data;
      }
    }
    
    // Fallback: return generic valid data
    return this.generateFallback(fieldAnalysis.type);
  }
}
```

---

### 3. Error Recovery Engine (Background Service Worker)

**File:** `background/error-recovery.js`

```javascript
class ErrorRecoveryEngine {
  constructor(dataGenerator) {
    this.dataGenerator = dataGenerator;
    this.errorPatterns = this.initializeErrorPatterns();
    this.recoveryHistory = new Map();
  }

  // Detect errors on page
  detectError(page) {
    const errorIndicators = this.findErrorIndicators(page);
    const errorMessages = this.parseErrorMessages(errorIndicators);
    
    return {
      hasError: errorMessages.length > 0,
      messages: errorMessages,
      affectedFields: this.mapErrorsToFields(errorMessages),
      severity: this.calculateSeverity(errorMessages)
    };
  }

  // Find error messages
  findErrorIndicators(page) {
    const selectors = [
      '.error-message',
      '.error',
      '[role="alert"]',
      '.alert-danger',
      '[class*="error"]',
      '[class*="invalid"]',
      'span[style*="color: red"]',
      'div.ng-invalid',
      '[aria-invalid="true"]'
    ];

    let indicators = [];
    selectors.forEach(selector => {
      indicators.push(...page.querySelectorAll(selector));
    });

    return [...new Set(indicators)]; // Deduplicate
  }

  // Parse error messages
  parseErrorMessages(elements) {
    return elements
      .map(el => ({
        text: el.textContent?.trim(),
        fieldName: this.extractFieldName(el),
        type: this.classifyError(el.textContent),
        element: el
      }))
      .filter(err => err.text && err.text.length > 0);
  }

  // Classify error types
  classifyError(message) {
    const patterns = {
      'format': /format|invalid format|wrong format|must be|should be/i,
      'required': /required|mandatory|must fill|cannot be empty|missing/i,
      'exists': /already exists|already registered|already in use|duplicate/i,
      'length': /too short|too long|at least|maximum|must be \d+/i,
      'pattern': /does not match|does not contain|pattern/i,
      'range': /must be between|out of range|minimum|maximum/i,
      'email': /invalid email|email already|email is/i,
      'phone': /invalid phone|phone number/i,
      'password': /weak password|password must|password does not/i
    };

    for (const [type, regex] of Object.entries(patterns)) {
      if (regex.test(message)) {
        return type;
      }
    }
    return 'unknown';
  }

  // Automatic recovery strategies
  async recover(error, fieldAnalysis) {
    const { type, affectedFields, messages } = error;
    
    let recoveryStrategy;
    switch (type) {
      case 'exists':
        recoveryStrategy = this.recoverFromExists(affectedFields[0]);
        break;
      case 'format':
        recoveryStrategy = this.recoverFromFormat(affectedFields[0], messages[0]);
        break;
      case 'length':
        recoveryStrategy = this.recoverFromLength(affectedFields[0], messages[0]);
        break;
      case 'required':
        recoveryStrategy = this.recoverFromRequired(affectedFields[0]);
        break;
      default:
        recoveryStrategy = this.recoverFromUnknown(affectedFields[0]);
    }

    return recoveryStrategy;
  }

  // Recovery: Email already exists
  recoverFromExists(fieldName) {
    return {
      action: 'regenerate',
      field: fieldName,
      strategy: 'Change email/phone to new value',
      newValue: this.dataGenerator.generateEmail({ 
        timestamp: Date.now() 
      }),
      retryCount: 1
    };
  }

  // Recovery: Format error
  recoverFromFormat(fieldName, errorMessage) {
    // Extract format hint from error message
    const formatHint = this.parseFormatHint(errorMessage);
    
    return {
      action: 'regenerate',
      field: fieldName,
      strategy: `Reformat to ${formatHint || 'correct format'}`,
      formatHint: formatHint,
      retryCount: 1
    };
  }

  // Recovery: Too short/long
  recoverFromLength(fieldName, errorMessage) {
    const length = this.parseLength(errorMessage);
    
    return {
      action: 'regenerate',
      field: fieldName,
      strategy: `Adjust to ${length.min}-${length.max} characters`,
      constraints: length,
      retryCount: 1
    };
  }

  // Learn from errors
  learnFromError(error, fieldAnalysis, attemptedValue) {
    const key = `${fieldAnalysis.type}:${error.type}`;
    
    if (!this.recoveryHistory.has(key)) {
      this.recoveryHistory.set(key, []);
    }
    
    this.recoveryHistory.get(key).push({
      fieldType: fieldAnalysis.type,
      errorType: error.type,
      attemptedValue: attemptedValue,
      failedAt: new Date(),
      solution: 'pending' // Updated after successful recovery
    });
  }
}
```

---

### 4. Profile Management (Background Service Worker)

**File:** `background/profile-manager.js`

```javascript
class ProfileManager {
  constructor() {
    this.profiles = new Map();
    this.encryptionKey = null;
    this.loadProfiles();
  }

  // Create profile
  createProfile(name, data) {
    const profile = {
      id: this.generateId(),
      name: name,
      data: data,
      createdAt: new Date(),
      updatedAt: new Date(),
      usageCount: 0,
      template: false // If true, it's a template for others to copy
    };

    this.profiles.set(profile.id, profile);
    this.saveProfile(profile);
    return profile;
  }

  // Save profile (encrypted)
  async saveProfile(profile) {
    const encrypted = await this.encryptData(profile);
    chrome.storage.local.set({
      [`profile_${profile.id}`]: encrypted
    });
  }

  // Load profiles
  async loadProfiles() {
    const data = await chrome.storage.local.get(null);
    
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('profile_')) {
        const decrypted = await this.decryptData(value);
        this.profiles.set(decrypted.id, decrypted);
      }
    }
  }

  // Get profile
  getProfile(id) {
    return this.profiles.get(id);
  }

  // List all profiles
  listProfiles() {
    return Array.from(this.profiles.values());
  }

  // Update profile
  updateProfile(id, updates) {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error('Profile not found');
    
    const updated = {
      ...profile,
      ...updates,
      updatedAt: new Date()
    };
    
    this.profiles.set(id, updated);
    this.saveProfile(updated);
    return updated;
  }

  // Delete profile
  deleteProfile(id) {
    this.profiles.delete(id);
    chrome.storage.local.remove(`profile_${id}`);
  }

  // Export profile (unencrypted JSON)
  exportProfile(id) {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error('Profile not found');
    
    return JSON.stringify(profile, null, 2);
  }

  // Import profile (from JSON)
  importProfile(jsonString) {
    const data = JSON.parse(jsonString);
    const profile = {
      ...data,
      id: this.generateId(), // Generate new ID to avoid conflicts
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.profiles.set(profile.id, profile);
    this.saveProfile(profile);
    return profile;
  }

  // Encrypt data using crypto.subtle
  async encryptData(data) {
    const jsonString = JSON.stringify(data);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(jsonString);

    const key = await this.getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      dataBuffer
    );

    return {
      iv: Array.from(iv),
      encryptedData: Array.from(new Uint8Array(encryptedBuffer))
    };
  }

  // Decrypt data
  async decryptData(encrypted) {
    const key = await this.getOrCreateKey();
    const iv = new Uint8Array(encrypted.iv);
    const encryptedBuffer = new Uint8Array(encrypted.encryptedData);

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encryptedBuffer
    );

    const decoder = new TextDecoder();
    const jsonString = decoder.decode(decryptedBuffer);
    return JSON.parse(jsonString);
  }

  // Get or create encryption key
  async getOrCreateKey() {
    let keyData = await chrome.storage.local.get('encryptionKey');
    
    if (!keyData.encryptionKey) {
      // Generate new key from user's browser fingerprint + timestamp
      const fingerprint = await this.generateFingerprint();
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(fingerprint),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
      
      keyData = { encryptionKey: key };
      chrome.storage.local.set(keyData);
    }
    
    return keyData.encryptionKey;
  }

  // Utility: Generate unique ID
  generateId() {
    return `profile_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

---

### 5. Popup UI (React Component)

**File:** `popup/App.jsx`

```jsx
import React, { useState, useEffect } from 'react';
import './popup.css';

function App() {
  const [formData, setFormData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    // Get current form data from content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getFormData' }, (response) => {
        setFormData(response);
        setLoading(false);
      });
    });

    // Load profiles
    chrome.runtime.sendMessage({ action: 'listProfiles' }, (response) => {
      setProfiles(response);
    });
  }, []);

  const handleFill = async () => {
    setStatus('processing');
    
    const fillData = selectedProfile 
      ? profiles.find(p => p.id === selectedProfile).data
      : formData; // Use auto-generated data

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, 
        { action: 'fillForm', data: fillData },
        (response) => {
          setStatus(response.success ? 'success' : 'error');
          setTimeout(() => setStatus('idle'), 2000);
        }
      );
    });
  };

  if (loading) {
    return <div className="popup-container"><p>Analyzing form...</p></div>;
  }

  if (!formData) {
    return <div className="popup-container"><p>No form detected</p></div>;
  }

  return (
    <div className="popup-container">
      <h2>Fake Data Filler</h2>

      {/* Profile Selection */}
      <div className="section">
        <label>Profile:</label>
        <select 
          value={selectedProfile || ''} 
          onChange={(e) => setSelectedProfile(e.target.value)}
        >
          <option value="">Generate New Data</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Form Preview */}
      <div className="section">
        <h3>Preview</h3>
        <div className="preview">
          {formData.fields.map((field, index) => (
            <div key={index} className="field-preview">
              <label>{field.label || field.type}</label>
              <input 
                type="text" 
                value={field.value || ''} 
                readOnly
                className="preview-input"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Status */}
      {status !== 'idle' && (
        <div className={`status ${status}`}>
          {status === 'success' && '✓ Form filled successfully'}
          {status === 'processing' && '⏳ Filling form...'}
          {status === 'error' && '✗ Error filling form'}
        </div>
      )}

      {/* Action Buttons */}
      <div className="actions">
        <button 
          className="btn btn-primary" 
          onClick={handleFill}
          disabled={status === 'processing'}
        >
          Fill Form
        </button>
        <button className="btn btn-secondary">Settings</button>
      </div>
    </div>
  );
}

export default App;
```

---

## Data Flow Diagram

```
User clicks "Fill Form"
      ↓
Content Script detects form
      ↓
Sends form analysis to Background Worker
      ↓
Data Generator creates data for each field
      ↓
Validation Engine checks constraints
      ↓
Popup shows preview
      ↓
User confirms
      ↓
Content Script fills form fields
      ↓
Page submits form
      ↓
IF error detected:
  Error Recovery Engine analyzes
      ↓
  Learns what went wrong
      ↓
  Regenerates problematic field(s)
      ↓
  Auto-resubmits (up to 3 times)
ELSE:
  Success!
```

---

## Storage Schema

### Local Storage (Encrypted)

```
profile_{uuid}:
{
  id: string
  name: string
  data: {
    email: string
    phone: string
    firstName: string
    lastName: string
    ... other fields
  }
  createdAt: ISO8601
  updatedAt: ISO8601
  usageCount: number
  template: boolean
}

settings:
{
  locale: string
  defaultEmailDomain: string
  autoFillSensitivity: 'aggressive' | 'conservative'
  errorRecoveryEnabled: boolean
  privacyMode: boolean
  domainWhitelist: string[]
  domainBlacklist: string[]
  autoClearOnClose: boolean
}

errorLearning_{fieldType}_{errorType}:
[
  {
    attemptedValue: string
    failedAt: ISO8601
    solution: string
  },
  ...
]
```

---

## Testing Strategy

### Unit Tests (Jest)
- Data generation edge cases
- Validation logic
- Error classification
- Encryption/decryption

### Integration Tests (Puppeteer)
- Fill form on real websites
- Error detection and recovery
- Multi-step form flows
- Dynamic field detection

### E2E Tests
- Full user workflows
- Profile management
- Settings persistence
- Cross-browser compatibility

---

## Performance Targets

| Metric | Target | Method |
|--------|--------|--------|
| Form analysis | <500ms | Optimize DOM queries, debounce mutations |
| Data generation | <100ms | Cache validation results |
| Encryption | <200ms | Use hardware-backed crypto |
| Popup render | <300ms | React memoization, lazy load profiles |
| Error detection | <1s | Debounce, use MutationObserver |

---

## Security Checklist

- [x] All data encrypted at rest
- [x] No network requests to external servers
- [x] Minimal permissions requested
- [x] No localStorage (use chrome.storage)
- [x] Content Security Policy strict
- [x] No eval() or dynamic code execution
- [x] Input sanitization before DOM insertion
- [x] XSS protection via React auto-escaping

---

## Deployment

1. Build production bundle: `npm run build`
2. Create `dist/` directory with:
   - `manifest.json`
   - `background.js` (bundled)
   - `content-script.js` (bundled)
   - `popup/index.html` + `popup.js` (bundled)
   - `icons/` (16x16, 48x48, 128x128)
3. Package: `zip -r extension.zip dist/`
4. Submit to Chrome Web Store
5. Submit to Firefox Add-ons
6. Submit to Microsoft Edge Add-ons

---

## Maintenance & Updates

- Weekly security patches
- Monthly feature releases
- Quarterly major versions
- Community-driven roadmap
- Open GitHub issues for bugs
- Feature requests via GitHub Discussions
