import type {
  EncryptedBlob,
  Profile,
  ProfileData,
  SupportedLocale,
} from '@/shared/types';
import { STORAGE_KEYS, LIMITS } from '@/shared/constants';
import { generateId, deepClone } from '@/shared/utils';

// =============================================================
// ProfileManager
// Uses AES-256-GCM (Web Crypto) to encrypt profiles at rest.
// The encryption key material is stored alongside the encrypted
// data in chrome.storage.local—this protects against
// casual inspection of exported storage snapshots.
// =============================================================

export class ProfileManager {
  private profiles = new Map<string, Profile>();
  private cryptoKey: CryptoKey | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  // -----------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------

  private async init(): Promise<void> {
    this.cryptoKey = await this.loadOrCreateKey();
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

    // Assign a fresh ID to avoid conflicts
    return this.create(String(data.name), data.data as ProfileData, {
      locale: data.locale as SupportedLocale,
      description: data.description as string | undefined,
      tags: data.tags as string[] | undefined,
      template: Boolean(data.template),
    });
  }

  // -----------------------------------------------------------
  // Encryption (AES-256-GCM via Web Crypto)
  // -----------------------------------------------------------

  private async encrypt(plainObj: unknown): Promise<EncryptedBlob> {
    if (!this.cryptoKey) throw new Error('CryptoKey not initialised.');

    const enc = new TextEncoder();
    const data = enc.encode(JSON.stringify(plainObj));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey,
      data,
    );

    return {
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(cipherBuffer)),
    };
  }

  private async decrypt(blob: EncryptedBlob): Promise<unknown> {
    if (!this.cryptoKey) throw new Error('CryptoKey not initialised.');

    const iv = new Uint8Array(blob.iv);
    const ciphertext = new Uint8Array(blob.ciphertext);

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey,
      ciphertext,
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plainBuffer));
  }

  // -----------------------------------------------------------
  // Key management
  // -----------------------------------------------------------

  private async loadOrCreateKey(): Promise<CryptoKey> {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.ENCRYPTION_KEY);
    const raw = stored[STORAGE_KEYS.ENCRYPTION_KEY] as number[] | undefined;

    if (raw && raw.length === 32) {
      return crypto.subtle.importKey(
        'raw',
        new Uint8Array(raw),
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    }

    // Generate a fresh 256-bit key
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );

    const exported = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.local.set({
      [STORAGE_KEYS.ENCRYPTION_KEY]: Array.from(new Uint8Array(exported)),
    });

    return key;
  }

  // -----------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------

  private async persistProfile(profile: Profile): Promise<void> {
    const blob = await this.encrypt(profile);
    await chrome.storage.local.set({ [STORAGE_KEYS.profileKey(profile.id)]: blob });
  }

  private async loadAllProfiles(): Promise<void> {
    const idsResult = await chrome.storage.local.get(STORAGE_KEYS.PROFILE_IDS);
    const ids = (idsResult[STORAGE_KEYS.PROFILE_IDS] as string[] | undefined) ?? [];

    const keys = ids.map(STORAGE_KEYS.profileKey);
    if (keys.length === 0) return;

    const stored = await chrome.storage.local.get(keys);

    for (const id of ids) {
      const blob = stored[STORAGE_KEYS.profileKey(id)] as EncryptedBlob | undefined;
      if (!blob) continue;
      try {
        const profile = (await this.decrypt(blob)) as Profile;
        this.profiles.set(profile.id, profile);
      } catch {
        // Decryption failed (e.g. key was regenerated) – skip entry
      }
    }
  }

  private async saveProfileIds(): Promise<void> {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROFILE_IDS]: Array.from(this.profiles.keys()),
    });
  }
}

// -----------------------------------------------------------
// Type guard
// -----------------------------------------------------------

function isProfileLike(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).name === 'string' &&
    typeof (v as Record<string, unknown>).data === 'object'
  );
}
