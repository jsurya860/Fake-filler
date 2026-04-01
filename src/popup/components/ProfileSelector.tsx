import React, { useRef, useState } from 'react';
import type { Profile, ProfileData, SupportedLocale } from '@/shared/types';
import { LOCALES } from '@/shared/constants';
import { sendToBackground } from '../api';

interface ProfileSelectorProps {
  profiles: Profile[];
  onProfilesChange: (updated: Profile[]) => void;
  onSelect: (id: string) => void;
  selectedId: string;
}

export function ProfileSelector({
  profiles,
  onProfilesChange,
  onSelect,
  selectedId,
}: ProfileSelectorProps): JSX.Element {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLocale, setNewLocale] = useState<SupportedLocale>('en-US');
  const [importError, setImportError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // -----------------------------------------------------------
  // Create
  // -----------------------------------------------------------

  async function handleCreate(): Promise<void> {
    if (!newName.trim()) return;
    const resp = await sendToBackground<Profile>({
      action: 'CREATE_PROFILE',
      payload: { name: newName.trim(), data: {} as ProfileData, locale: newLocale },
    });
    if (resp.success && resp.data) {
      onProfilesChange([...profiles, resp.data]);
      onSelect(resp.data.id);
      setNewName('');
      setShowCreate(false);
    }
  }

  // -----------------------------------------------------------
  // Delete
  // -----------------------------------------------------------

  async function handleDelete(id: string): Promise<void> {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    await sendToBackground({ action: 'DELETE_PROFILE', payload: { id } });
    onProfilesChange(profiles.filter((p) => p.id !== id));
    if (selectedId === id) onSelect('');
  }

  // -----------------------------------------------------------
  // Export
  // -----------------------------------------------------------

  async function handleExport(id: string): Promise<void> {
    const resp = await sendToBackground<string>({
      action: 'EXPORT_PROFILE',
      payload: { id },
    });
    if (!resp.success || !resp.data) return;

    const blob = new Blob([resp.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fdf-profile-${id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -----------------------------------------------------------
  // Import
  // -----------------------------------------------------------

  function handleImportClick(): void {
    fileInputRef.current?.click();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const resp = await sendToBackground<Profile>({
      action: 'IMPORT_PROFILE',
      payload: { json: text },
    });

    if (resp.success && resp.data) {
      onProfilesChange([...profiles, resp.data]);
    } else {
      setImportError(resp.error ?? 'Import failed.');
    }

    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // -----------------------------------------------------------
  // Render
  // -----------------------------------------------------------

  return (
    <section className="profiles-section">
      <div className="profiles-header">
        <h2 className="section-title">Profiles</h2>
        <div className="profiles-actions">
          <button className="btn btn--xs btn--secondary" onClick={handleImportClick}>
            📥 Import
          </button>
          <button
            className="btn btn--xs btn--primary"
            onClick={() => setShowCreate((p) => !p)}
          >
            ➕ New
          </button>
        </div>
      </div>

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => void handleImportFile(e)}
      />

      {importError && (
        <div className="error-banner" role="alert">⚠️ {importError}</div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="create-profile-form">
          <input
            className="field-input"
            type="text"
            placeholder="Profile name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            autoFocus
          />
          <select
            className="field-select"
            value={newLocale}
            onChange={(e) => setNewLocale(e.target.value as SupportedLocale)}
          >
            {LOCALES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <div className="create-profile-btns">
            <button className="btn btn--xs btn--ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
            <button
              className="btn btn--xs btn--primary"
              onClick={() => void handleCreate()}
              disabled={!newName.trim()}
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Profile list */}
      {profiles.length === 0 ? (
        <div className="empty-state">
          <p>No profiles saved yet.</p>
        </div>
      ) : (
        <ul className="profile-list">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className={`profile-item ${selectedId === profile.id ? 'profile-item--selected' : ''}`}
              onClick={() => onSelect(profile.id)}
            >
              <div className="profile-item__info">
                <span className="profile-item__name">{profile.name}</span>
                <span className="profile-item__meta">
                  {profile.locale} · used {profile.usageCount}×
                </span>
              </div>
              <div className="profile-item__actions">
                <button
                  className="icon-btn"
                  title="Export"
                  onClick={(e) => { e.stopPropagation(); void handleExport(profile.id); }}
                >
                  📤
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  title={confirmDeleteId === profile.id ? 'Click again to confirm' : 'Delete'}
                  onClick={(e) => { e.stopPropagation(); void handleDelete(profile.id); }}
                >
                  {confirmDeleteId === profile.id ? '⚠️' : '🗑️'}
                </button>
                {confirmDeleteId === profile.id && (
                  <button
                    className="icon-btn"
                    title="Cancel"
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

