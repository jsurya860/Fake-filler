# Advanced Fake Data Filler Extension - Development Prompt

## Project Overview

Build a **next-generation fake data filler browser extension** that intelligently auto-detects form fields, generates valid data, and provides error recovery—surpassing all current market solutions in robustness, user experience, and security.

---

## Core Requirements

### 1. Intelligent Form Field Detection

**Auto-Detection System:**
- **Machine Learning-based field recognition** — Don't rely on HTML `name` or `id` attributes alone. Analyze:
  - Placeholder text ("Enter your email", "MM/DD/YYYY")
  - Label text and visual proximity to inputs
  - Field type attributes (email, tel, number, date, password, text)
  - CSS classes and styling hints
  - Aria-label and aria-describedby attributes
  - Position context (fields grouped together, payment form patterns)
  
- **Field Classification** — Accurately identify:
  - Text fields (name, address, company, username)
  - Email fields
  - Phone number fields (support multiple country formats)
  - Date/time fields (detect format: MM/DD/YYYY, DD/MM/YYYY, ISO 8601)
  - Numeric fields (age, postal code, zip code)
  - Currency/money fields
  - Credit card fields (validate Luhn algorithm)
  - Checkboxes, radio buttons, select dropdowns
  - Hidden fields (skip them)
  - Read-only fields (detect and skip)
  - Required vs optional fields
  - Conditional fields (show/hide based on other fields)

- **Validation Rule Detection** — Extract constraints from:
  - HTML5 `min`, `max`, `pattern`, `required`, `maxlength` attributes
  - Regex patterns in data attributes
  - Visual labels ("Must be 18+", "At least 8 characters")
  - Error messages from validation libraries (Yup, Joi, Zod, HTML5)

---

### 2. Smart Data Generation Engine

**Context-Aware Generation:**
- Generate data that **passes field validation** before filling
- Support multiple locales (US, UK, EU, Asia-Pacific, etc.)
  - Phone formats: (555) 123-4567 vs +1-555-123-4567 vs 555.123.4567
  - Dates: MM/DD/YYYY vs DD/MM/YYYY vs DD/MM/YY
  - Postal codes: US ZIP, UK postcode, EU formats
  - Names: Culturally appropriate first/last names
  
- **Data Type Support:**
  - Names (first, last, full)
  - Emails (firstname.lastname@example.com, or custom domain)
  - Phone numbers (valid, mobile or landline)
  - Dates (birthdate, registration date, future dates)
  - Addresses (street, city, state/province, postal code, country)
  - Company names and job titles
  - Credit cards (generate valid Luhn checksums, non-real card numbers)
  - URLs and website addresses
  - Usernames (alphanumeric, with/without underscores)
  - Passwords (strong, meeting complexity requirements)
  - Text descriptions and bios (Lorem ipsum or contextual)
  - Numbers (with min/max constraints)
  - Currencies (with proper formatting)
  - Select dropdown options (intelligently pick from available options)

- **Realistic Data Patterns:**
  - Consistent data across related fields (if name is "John Smith", email could be john.smith@...)
  - Age generation that matches "18+" constraints
  - Phone numbers that don't validate as real (use 555 exchange for US)
  - Credit cards that fail if used (use test card numbers: 4111111111111111, etc.)

---

### 3. Error Recovery & Self-Healing

**Auto-Recovery System:**
- **Form Submission Detection** — Detect when:
  - Form submission fails
  - Validation error messages appear (inline, toast, modal, or page redirect)
  - Error text appears near form fields
  
- **Error Analysis** — Parse error messages to understand:
  - "Email already exists" → Change email, retry
  - "Phone must be 10 digits" → Reformat or regenerate
  - "Date must be in MM/DD/YYYY format" → Reformat from DD/MM/YYYY
  - "Password must contain uppercase" → Regenerate with uppercase
  - "Name is required" → It was empty, refill
  
- **Smart Retry Logic:**
  - Extract field names from error messages
  - Identify which field(s) caused the error
  - Adjust generation constraints and retry that field only
  - Support up to 3 auto-retry attempts before asking user
  - Learn from failures: store what didn't work for future fills
  
- **User Override Options:**
  - Show error message to user
  - Offer to manually edit the problematic field
  - Suggest alternatives (different email provider, phone format, etc.)
  - Option to skip that field and continue

---

### 4. User Experience & Interface

**Extension Popup Interface:**
- **One-Click Fill** — Simple "Fill Form" button for quick operations
- **Preview Before Fill** — Show what data will be entered:
  ```
  Name: John Smith
  Email: john.smith@testdomain.com
  Phone: (555) 123-4567
  [Confirm] [Edit] [Cancel]
  ```

- **Per-Field Controls:**
  - Click any field in the preview to edit it
  - Regenerate individual fields without refilling entire form
  - Mark fields as "skip" if not needed
  - Add custom values for specific fields

- **Profile Management:**
  - Save profiles: "Test User", "Premium User", "International"
  - Switch between profiles from popup
  - Edit profile templates
  - Delete unused profiles
  - Import/export profiles (JSON format, encrypted)
  - Profile versioning (keep history of changes)

- **Settings Panel:**
  - Locale/country selection (affects phone, date, address formats)
  - Default email domain (@testdomain.com or custom)
  - Auto-fill sensitivity (aggressive vs conservative)
  - Error recovery mode toggle
  - Privacy mode (ephemeral data, no storage)
  - Domain whitelist/blacklist
  - Auto-clear profiles on close (security)

- **Status Indicator:**
  - Green checkmark: Form successfully filled
  - Yellow warning: Some fields couldn't be auto-filled, needs manual entry
  - Red error: Recovery failed, manual intervention needed
  - Loading spinner: Processing form analysis

---

### 5. Advanced Detection & Context Awareness

**Form Type Recognition:**
- **Signup Forms** — Detect multi-step registration, email verification
- **Login Forms** — Skip (never fill unless in private mode)
- **Payment Forms** — Detect payment processors (Stripe, PayPal, Square)
  - Use test card numbers
  - Don't store actual payment data
- **Search Forms** — Generate relevant search queries based on page context
- **Filter/Sort Forms** — Auto-select reasonable defaults
- **Multi-step Forms** — Track progress across pages
- **Conditional Forms** — If user selects "Business", show business-specific fields

**Progressive Enhancement:**
- If form uses AJAX validation, detect and respond to real-time validation
- Handle forms that load fields dynamically (JavaScript-heavy)
- Support shadow DOM forms (Web Components)
- Handle iframes (if permissions allow)

---

### 6. Security & Privacy

**Local-First Architecture:**
- **Zero Backend** — All data generation happens in the browser
- **Encrypted Storage** — Use `crypto.subtle` API to encrypt profiles at rest
  - Key derivation from user's system
  - Never store encryption keys separately
- **No Telemetry** — No data sent to external servers
- **Optional: No Logging** — User can disable any local logging

**Permissions Minimalism:**
- Request only `activeTab` + `scripting` (not `all_urls`, `webRequest`, etc.)
- Domain whitelist enforcement (ask permission per-domain)
- Clear denial on sensitive sites (banks, email providers, password managers)
- Visual warning on first use

**Data Handling:**
- Clear separation between real data and fake data
- Auto-delete option: Remove profiles on browser close
- Manual deletion with confirmation
- Data audit trail (what was filled, when, where)
- Export data in plaintext for backup, then delete original
- No cross-device sync (unless explicitly enabled and encrypted)

---

### 7. Testing & Validation

**Built-in Test Suites:**
- Test on common form libraries:
  - HTML5 native forms
  - Formik (React)
  - React Hook Form
  - Angular Forms
  - Vue Form
  - Django Forms
  - Laravel Forms
  
- Compatibility matrix:
  - Chrome 90+, Edge 90+, Firefox 88+, Safari 15+
  - Test on live websites (signup forms, contact forms, etc.)
  - Validation against real field constraints

- Error recovery test scenarios:
  - Simulate "email already exists" error
  - Simulate format validation failures
  - Simulate required field missing
  - Test retry logic

---

### 8. Documentation & Onboarding

**User Documentation:**
- **Quick Start Guide** — 3 steps to first fill
- **FAQ** — Common issues and solutions
- **Video Tutorial** — Show auto-detection, profile creation, error recovery
- **Keyboard Shortcuts** — Alt+F (fill), Alt+P (open popup), Alt+S (settings)

**Developer Documentation:**
- Architecture overview
- How ML detection works
- How to extend for custom field types
- Data generation algorithms
- Testing guide

---

## Implementation Stack (Recommended)

**Frontend:**
- React or Vue for popup UI
- Tailwind CSS for styling
- TensorFlow.js for field ML detection (lightweight)
- crypto-js or libsodium.js for encryption

**Backend:**
- None (local-only, no server)
- Optional: GitHub for public code + issue tracking

**Data Storage:**
- Chrome Storage API (`chrome.storage.local`)
- IndexedDB for larger profile datasets
- Encrypted JSON exports

**Libraries:**
- `faker.js` or `casual.js` for data generation
- `yup` or `joi` for schema validation
- `lodash` for utilities
- `axios` for potential API testing needs

---

## Success Metrics

The extension should achieve:
1. **Auto-detection accuracy** ≥ 90% (correctly identify field types)
2. **Valid data generation** ≥ 95% (passes form validation on first try)
3. **Error recovery success rate** ≥ 80% (fixes validation errors automatically)
4. **User satisfaction** ≥ 4.5/5 stars (intuitive, fast, reliable)
5. **Zero security breaches** (open-source audit, no data leaks)
6. **Performance** — Form analysis < 500ms, data generation < 100ms

---

## Future Enhancements (Phase 2+)

1. **Team Collaboration** — Share profiles across team members (encrypted)
2. **Test Data Management** — Manage thousands of fake identities for bulk testing
3. **CI/CD Integration** — API to trigger fills programmatically
4. **Visual Regression Testing** — Fill forms for screenshot testing
5. **Accessibility Testing** — Generate data that tests form accessibility
6. **Localization** — Support all major languages and locales
7. **Analytics** — Dashboard showing fill statistics, error patterns (anonymized)
8. **Mobile Apps** — Native Android/iOS apps with same functionality
9. **API Mode** — Headless mode for automation frameworks
10. **Browser Sync** — Sync profiles across devices (with encryption)

---

## Delivery Milestones

**Phase 1 (MVP):**
- Basic form detection
- Simple data generation
- Manual fill + preview
- Single profile support
- Chrome only

**Phase 2 (v1.0):**
- ML-based field detection
- Error recovery
- Profile management
- Multi-browser support (Firefox, Edge)
- Security hardening

**Phase 3 (v2.0):**
- Advanced validation
- Team features
- Enhanced UX/UI
- Comprehensive documentation

---

## Testing Checklist

- [ ] Form detection works on major websites (Google, GitHub, Slack, etc.)
- [ ] Data generation passes HTML5 validation
- [ ] Error recovery handles common error scenarios
- [ ] Profiles save and load correctly
- [ ] Encryption/decryption works without data loss
- [ ] No data leaks in browser console or network tab
- [ ] Works offline (all processing is local)
- [ ] Keyboard navigation fully functional
- [ ] Screen reader compatible (basic accessibility)
- [ ] Mobile responsive (popup UI)
- [ ] Works with password managers (no conflicts)
- [ ] No performance regression on form-heavy sites

---

## Code Quality Standards

- **TypeScript** for type safety
- **ESLint + Prettier** for code formatting
- **Jest** for unit tests (target: >80% coverage)
- **E2E tests** with Puppeteer/Playwright
- **Code comments** for complex logic
- **Git history** with meaningful commit messages
- **Semantic versioning** for releases

---

## Open Source & Community

- Publish on GitHub as public repository
- MIT or Apache 2.0 license
- CONTRIBUTING.md with guidelines
- Issue templates for bug reports and feature requests
- Community discussion board (GitHub Discussions)
- Regular updates and maintenance
- Security vulnerability disclosure policy

---

## Key Differentiators vs. Current Market Solutions

| Feature | Current Fillers | This Extension |
|---------|-----------------|---|
| **Field Detection** | Basic (HTML attributes only) | **ML-powered, context-aware** |
| **Validation** | Manual (user fixes errors) | **Auto-validates, error recovery** |
| **Data Quality** | Generic (may fail forms) | **Passes validation on first try** |
| **User Experience** | Multiple clicks, configuration | **One-click, smart defaults** |
| **Security** | Cloud-based (data sent to servers) | **Local-only, encrypted** |
| **Error Handling** | Show error to user | **Auto-fix most errors** |
| **Profile Management** | Limited | **Full CRUD, versioning** |
| **Customization** | Few options | **Extensive templates & rules** |
| **Team Support** | None | **Shareable encrypted profiles** |
| **Transparency** | Proprietary | **Open-source, auditable** |

---

## Questions for Clarification Before Building

1. Should the extension support non-English forms? (Which languages priority?)
2. Should profiles be shareable between devices/accounts? (Need cloud sync?)
3. Should there be a dashboard for team analytics?
4. What payment models? (Free, freemium, premium, enterprise?)
5. Should it integrate with test automation frameworks (Selenium, Cypress)?
6. Should it support custom validation rule creation by users?
7. Maximum number of profiles per user?
8. Should it work on mobile browsers (Firefox Mobile, Chrome Mobile)?

---

## Final Note

This extension should feel like the next evolution in form filling—intelligent, invisible, and always working. Users should feel like they're using a tool built specifically for their workflow, not a generic form filler. The killer feature is error recovery: the extension should fix problems before the user even notices them.

Build something that makes form filling delightful, not just faster.
