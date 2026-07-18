import { useEffect, useRef, useState } from 'react';
import type { DebugLogEntry } from '@/shared/types';
import { sendToBackground } from '../api';
import { logSwallowed } from '@/shared/messaging';

export function DebugPanel(): JSX.Element {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [running, setRunning] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    let id: number | null = null;

    async function fetchLogs() {
      try {
        const resp = await sendToBackground<DebugLogEntry[]>({ action: 'GET_DEBUG_LOGS' });
        if (!mounted) return;
        if (resp.success && resp.data) setLogs(resp.data);
      } catch (e) { logSwallowed('src/popup/components/DebugPanel.tsx', e); }
    }

    if (running) {
      void fetchLogs();
      id = window.setInterval(() => void fetchLogs(), 1000);
    }

    return () => {
      mounted = false;
      if (id) window.clearInterval(id);
    };
  }, [running]);

  useEffect(() => {
    // auto-scroll to bottom
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [logs]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <strong>Debug logs</strong>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn--tiny"
          onClick={() => {
            setRunning((r) => !r);
          }}
        >
          {running ? 'Pause' : 'Resume'}
        </button>
        <button
          className="btn btn--tiny"
          onClick={() => {
            void (async () => {
              try {
                await sendToBackground({ action: 'CLEAR_DEBUG_LOGS' });
                setLogs([]);
              } catch (e) { logSwallowed('src/popup/components/DebugPanel.tsx', e); }
            })();
          }}
          style={{ marginLeft: 6 }}
        >
          Clear
        </button>
      </div>

      <div
        ref={containerRef}
        style={{ height: 220, overflowY: 'auto', background: 'var(--panel-bg)', padding: 8, borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }}
      >
        {logs.length === 0 ? (
          <div style={{ color: 'var(--clr-text-muted)' }}>No logs yet.</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}>
              <div style={{ color: 'var(--clr-text-muted)', fontSize: 11 }}>[{new Date(l.ts).toLocaleTimeString()}] {l.source} • {l.level}</div>
              <div>{l.message}{l.args && l.args.length > 1 ? ' ' + JSON.stringify(l.args.slice(1)) : ''}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
