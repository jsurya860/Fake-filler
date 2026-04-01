import type { AppStatus } from '@/shared/types';

interface StatusBadgeProps {
  status: AppStatus;
}

const STATUS_CONFIG: Record<
  AppStatus,
  { icon: string; label: string; className: string }
> = {
  idle: { icon: '●', label: 'Ready', className: 'badge--idle' },
  analyzing: { icon: '⏳', label: 'Analyzing…', className: 'badge--busy' },
  generating: { icon: '⚙️', label: 'Generating…', className: 'badge--busy' },
  filling: { icon: '✏️', label: 'Filling…', className: 'badge--busy' },
  success: { icon: '✅', label: 'Done!', className: 'badge--success' },
  error: { icon: '❌', label: 'Error', className: 'badge--error' },
  'no-form': { icon: '📋', label: 'No form', className: 'badge--idle' },
};

export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const config = STATUS_CONFIG[status];
  return (
    <span className={`status-badge ${config.className}`} aria-live="polite">
      {config.icon} {config.label}
    </span>
  );
}
