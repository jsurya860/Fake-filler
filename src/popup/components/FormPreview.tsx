import { useState } from 'react';
import type { FieldAnalysis, FormAnalysis } from '@/shared/types';

interface FormPreviewProps {
  form: FormAnalysis;
  onFieldChange: (fieldId: string, value: string) => void;
  onSkipField: (fieldId: string, skip: boolean) => void;
  options?: { onlyRequired?: boolean; compact?: boolean };
}

const SKIPPABLE_TYPES = new Set(['hidden', 'file']);

export function FormPreview({
  form,
  onFieldChange,
  onSkipField,
  options,
}: FormPreviewProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const baseFiltered = form.fields.filter(
    (f) => !SKIPPABLE_TYPES.has(f.type) && !f.constraints.readOnly && !f.constraints.disabled,
  );
  const visibleFields = options?.onlyRequired
    ? baseFiltered.filter((f) => f.required)
    : baseFiltered;

  return (
    <section className="preview-section">
      <h2 className="preview-title">
        Preview
        <span className="preview-badge">{form.type}</span>
        <span className="preview-count">{visibleFields.length} fields</span>
      </h2>

      <div className={`preview-list ${options?.compact ? 'preview-list--compact' : ''}`}>
        {visibleFields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            isEditing={editingId === field.id}
            onStartEdit={() => setEditingId(field.id)}
            onStopEdit={() => setEditingId(null)}
            onFieldChange={onFieldChange}
            onSkipField={onSkipField}
            compact={!!options?.compact}
          />
        ))}
      </div>
    </section>
  );
}

// =============================================================
// FieldRow
// =============================================================

interface FieldRowProps {
  field: FieldAnalysis;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onFieldChange: (fieldId: string, value: string) => void;
  onSkipField: (fieldId: string, skip: boolean) => void;
  compact?: boolean;
}

function FieldRow({
  field,
  isEditing,
  onStartEdit,
  onStopEdit,
  onFieldChange,
  onSkipField,
  compact = false,
}: FieldRowProps): JSX.Element {
  const displayLabel = field.label || field.name || field.type;
  const hasValue = field.value !== undefined && field.value !== '';

  function iconForType(t: string): string {
    switch (t) {
      case 'email': return '✉️';
      case 'tel': return '📞';
      case 'password': return '🔒';
      case 'text': return '🔤';
      case 'select': return '▾';
      case 'checkbox': return '☑️';
      case 'radio': return '◉';
      default: return '🔸';
    }
  }

  return (
    <div className={`field-row-preview ${field.skip ? 'field-row-preview--skipped' : ''} ${compact ? 'field-row-preview--compact' : ''}`}>
      <div className="field-row-preview__meta">
        <span className="field-type-badge" title={field.type}>{iconForType(field.type)}</span>
        <span className="field-label-text" title={displayLabel}>
          {displayLabel}
        </span>
        {field.required && <span className="required-mark">*</span>}
        {field.confidence < 0.6 && (
          <span className="confidence-warn" title="Low detection confidence">
            ⚠️
          </span>
        )}
      </div>

      {isEditing ? (
        <div className="field-edit-row">
          <input
            className="field-edit-input"
            type={field.htmlType === 'password' ? 'text' : field.htmlType}
            value={field.value ?? ''}
            placeholder={field.placeholder || `Enter ${field.type}…`}
            autoFocus
            onChange={(e) => onFieldChange(field.id, e.target.value)}
            onBlur={onStopEdit}
            onKeyDown={(e) => e.key === 'Enter' && onStopEdit()}
            maxLength={field.constraints.maxLength ?? undefined}
          />
        </div>
      ) : (
        <div className="field-value-row">
          <span
            className={`field-value ${!hasValue ? 'field-value--empty' : ''}`}
            title={field.value}
            onClick={onStartEdit}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onStartEdit()}
          >
            {field.value || '—'}
          </span>
          <div className="field-actions">
            <button
              className="icon-btn"
              title="Edit value"
              onClick={onStartEdit}
            >
              ✏️
            </button>
            <button
              className={`icon-btn ${field.skip ? 'icon-btn--active' : ''}`}
              title={field.skip ? 'Include field' : 'Skip field'}
              onClick={() => onSkipField(field.id, !field.skip)}
            >
              {field.skip ? '👁️' : '🚫'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
