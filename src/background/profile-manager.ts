import type {
  Profile,
  ProfileData,
  SupportedLocale,
} from '@/shared/types';
import { STORAGE_KEYS, LIMITS, SUPPORTED_LOCALES } from '@/shared/constants';
import { generateId, deepClone } from '@/shared/utils';
import { logSwallowed } from '@/shared/messaging';

// =============================================================
// ProfileManager
// Profiles are stored as plaintext JSON in chrome.storage.local.
//
// NOTE: A previous version applied AES-256-GCM encryption, but the key
// material was stored alongside the ciphertext in the same storage area,
// which provided no meaningful isolation. The encryption layer has been
// removed to avoid false security assurances. Profiles do not contain
// credentials or financial data — they hold display preferences only.
// =============================================================

export class ProfileManager {
  private profiles = new Map<string, Profile>();
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  // -----------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------

  private async init(): Promise<void> {
    await this.loadAllProfiles();
  }

  /** Wait for init() to finish before performing any operation */
  async whenReady(): Promise<void> {
    return this.ready;
  }

  // -----------------------------------------------------------
  // Public CRUD
  // -----------------------------------------------------------

  async create(
    name: string,
    data: ProfileData,
    options: {
      locale?: SupportedLocale;
      description?: string;
      tags?: string[];
      template?: boolean;
    } = {},
  ): Promise<Profile> {
    await this.ready;

    if (this.profiles.size >= LIMITS.MAX_PROFILES) {
      throw new Error(`Profile limit of ${LIMITS.MAX_PROFILES} reached.`);
    }

    const profile: Profile = {
      id: generateId('prof'),
      name: name.trim(),
      description: options.description,
      tags: options.tags ?? [],
      data,
      locale: options.locale ?? 'en-US',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usageCount: 0,
      template: options.template ?? false,
    };

    this.profiles.set(profile.id, profile);
    await this.persistProfile(profile);
    await this.saveProfileIds();

    return deepClone(profile);
  }

  async getAll(): Promise<Profile[]> {
    await this.ready;
    return Array.from(this.profiles.values()).map(deepClone);
  }

  async getById(id: string): Promise<Profile | null> {
    await this.ready;
    const p = this.profiles.get(id);
    return p ? deepClone(p) : null;
  }

  async update(id: string, updates: Partial<Omit<Profile, 'id' | 'createdAt'>>): Promise<Profile> {
    await this.ready;

    const existing = this.profiles.get(id);
    if (!existing) throw new Error(`Profile "${id}" not found.`);

    const updated: Profile = {
      ...existing,
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.profiles.set(id, updated);
    await this.persistProfile(updated);

    return deepClone(updated);
  }

  async incrementUsage(id: string): Promise<void> {
    await this.ready;
    const profile = this.profiles.get(id);
    if (profile) {
      profile.usageCount += 1;
      profile.updatedAt = new Date().toISOString();
      await this.persistProfile(profile);
    }
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    this.profiles.delete(id);
    await chrome.storage.local.remove(STORAGE_KEYS.profileKey(id));
    await this.saveProfileIds();
  }

  // -----------------------------------------------------------
  // Import / Export (plaintext JSON – user's responsibility)
  // -----------------------------------------------------------

  async exportProfile(id: string): Promise<string> {
    const profile = await this.getById(id);
    if (!profile) throw new Error(`Profile "${id}" not found.`);
    return JSON.stringify(profile, null, 2);
  }

  async importProfile(jsonString: string): Promise<Profile> {
    let data: unknown;
    try {
      data = JSON.parse(jsonString);
    } catch {
      throw new Error('Invalid JSON string.');
    }

    if (!isProfileLike(data)) {
      throw new Error('JSON does not look like a valid profile.');
    }

    // Validate locale against the supported allowlist to prevent arbitrary
    // locale strings from being injected via imported profile JSON.
    const rawLocale = data.locale as string | undefined;
    const locale: SupportedLocale = SUPPORTED_LOCALES.includes(rawLocale as SupportedLocale)
      ? (rawLocale as SupportedLocale)
      : 'en-US';

    // Assign a fresh ID to avoid conflicts
    return this.create(String(data.name), data.data as ProfileData, {
      locale,
      description: typeof data.description === 'string' ? data.description : undefined,
      tags: Array.isArray(data.tags) ? (data.tags as string[]).filter((t) => typeof t === 'string') : undefined,
      template: Boolean(data.template),
    });
  }

  // -----------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------

  private async persistProfile(profile: Profile): Promise<void> {
    // Profiles are stored as plaintext JSON objects. The previous AES-GCM
    // encryption scheme offered no real security because the key was stored
    // in the same chrome.storage.local namespace as the ciphertext.
    await chrome.storage.local.set({ [STORAGE_KEYS.profileKey(profile.id)]: profile });
  }

  private async loadAllProfiles(): Promise<void> {
    const idsResult = await chrome.storage.local.get(STORAGE_KEYS.PROFILE_IDS);
    const ids = (idsResult[STORAGE_KEYS.PROFILE_IDS] as string[] | undefined) ?? [];

    const keys = ids.map(STORAGE_KEYS.profileKey);
    if (keys.length === 0) return;

    const stored = await chrome.storage.local.get(keys);

    for (const id of ids) {
      const entry: unknown = stored[STORAGE_KEYS.profileKey(id)];
      if (!entry) continue;
      try {
        // Legacy format check: prior builds stored an EncryptedBlob { iv, ciphertext }.
        // These cannot be decrypted without the now-removed key infrastructure,
        // so they are skipped with a warning. Users need to recreate them.
        if (isLegacyEncryptedBlob(entry)) {
          try { console.warn('[FDF Pro] Skipping legacy encrypted profile', id, '– please recreate it.'); } catch (e) { logSwallowed('src/background/profile-manager.ts', e); }
          continue;
        }
        const profile = entry as Profile;
        this.profiles.set(profile.id, profile);
      } catch {
        // Skip corrupted entries silently
      }
    }

    // Clean up legacy key material — it provided no real isolation.
    try { await chrome.storage.local.remove(STORAGE_KEYS.ENCRYPTION_KEY); } catch (e) { logSwallowed('src/background/profile-manager.ts', e); }
  }

  private async saveProfileIds(): Promise<void> {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROFILE_IDS]: Array.from(this.profiles.keys()),
    });
  }
}

// -----------------------------------------------------------
// Type guards
// -----------------------------------------------------------

function isProfileLike(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).name === 'string' &&
    typeof (v as Record<string, unknown>).data === 'object'
  );
}

/** Detect the legacy AES-GCM EncryptedBlob format { iv: number[], ciphertext: number[] }. */
function isLegacyEncryptedBlob(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj.iv) && Array.isArray(obj.ciphertext);
}
