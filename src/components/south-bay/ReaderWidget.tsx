import { useState, useRef, useEffect } from 'react';

type TipType = 'event' | 'tip' | 'correction' | 'feedback';
type Status = 'idle' | 'open' | 'sending' | 'sent' | 'error';

const TYPE_OPTIONS: { value: TipType; label: string; emoji: string; placeholder: string }[] = [
  { value: 'event',      label: 'Event',      emoji: '📅', placeholder: 'What's happening, when, and where?' },
  { value: 'tip',        label: 'News Tip',   emoji: '📰', placeholder: 'What's the story? Include any details you have.' },
  { value: 'correction', label: 'Correction', emoji: '⚠️', placeholder: 'What's wrong, and what should it say?' },
  { value: 'feedback',   label: 'Feedback',   emoji: '💬', placeholder: 'What's on your mind?' },
];

export default function ReaderWidget() {
  const [status, setStatus] = useState<Status>('idle');
  const [type, setType] = useState<TipType>('feedback');
  const [message, setMessage] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (status === 'open') textareaRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (status !== 'open') return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setStatus('idle');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [status]);

  useEffect(() => {
    if (status !== 'open') return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setStatus('idle'); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [status]);

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/reader-tip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, message: message.trim(), page: window.location.href }),
      });
      if (res.ok) {
        setStatus('sent');
        setMessage('');
        setTimeout(() => setStatus('idle'), 2500);
      } else {
        setStatus('error');
        setTimeout(() => setStatus('open'), 2500);
      }
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('open'), 2500);
    }
  };

  const currentType = TYPE_OPTIONS.find(o => o.value === type)!;

  const btnStyle: React.CSSProperties = {
    position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
    background: '#1c1917', color: '#fafaf9',
    border: 'none', borderRadius: 999,
    padding: '10px 18px', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    fontFamily: 'inherit',
  };

  const panelStyle: React.CSSProperties = {
    position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
    background: '#fdfaf5', borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
    border: '1px solid #e7e0d5',
    width: 340, maxWidth: 'calc(100vw - 40px)',
  };

  if (status === 'idle') {
    return (
      <button style={btnStyle} onClick={() => setStatus('open')} aria-label="Submit a tip or feedback">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 0 0 1.33 0l1.713-3.293c.121-.233.362-.393.642-.413 1.198-.087 2.382-.226 3.55-.414 1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.803 41.803 0 0 0 10 2Z" clipRule="evenodd" />
        </svg>
        <span>Tips &amp; Feedback</span>
      </button>
    );
  }

  if (status === 'sent') {
    return (
      <div style={{ ...panelStyle, padding: '24px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>📬</div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1c1917' }}>Got it — thanks!</p>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#78716c' }}>We read every message.</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={{ ...panelStyle, padding: '20px', textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#dc2626' }}>Couldn't send — try again?</p>
      </div>
    );
  }

  return (
    <div ref={panelRef} style={panelStyle}>
      {/* Header */}
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #e7e0d5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1c1917', letterSpacing: '-0.01em' }}>Tips &amp; Feedback</span>
        <button onClick={() => setStatus('idle')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a8a29e', padding: 4, lineHeight: 1 }} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Type chips */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setType(opt.value)}
              style={{
                padding: '7px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.12s',
                border: type === opt.value ? '1.5px solid #1c1917' : '1.5px solid #e7e0d5',
                background: type === opt.value ? '#1c1917' : '#fff',
                color: type === opt.value ? '#fafaf9' : '#57534e',
                fontFamily: 'inherit',
              }}
            >
              {opt.emoji} {opt.label}
            </button>
          ))}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder={currentType.placeholder}
          rows={4}
          maxLength={2000}
          style={{
            width: '100%', boxSizing: 'border-box',
            borderRadius: 8, border: '1.5px solid #e7e0d5',
            background: '#faf7f2', padding: '10px 12px',
            fontSize: 13, color: '#1c1917', fontFamily: 'inherit',
            resize: 'none', outline: 'none',
          }}
          onFocus={e => { e.target.style.borderColor = '#a8a29e'; }}
          onBlur={e => { e.target.style.borderColor = '#e7e0d5'; }}
        />

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!message.trim() || status === 'sending'}
          style={{
            width: '100%', padding: '10px', borderRadius: 8, border: 'none',
            background: !message.trim() || status === 'sending' ? '#d6d3d1' : '#1c1917',
            color: '#fafaf9', fontSize: 13, fontWeight: 600,
            cursor: !message.trim() || status === 'sending' ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', transition: 'background 0.15s',
          }}
        >
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>

        <p style={{ margin: 0, fontSize: 11, color: '#a8a29e', textAlign: 'center' }}>
          Anonymous — no account needed
        </p>
      </div>
    </div>
  );
}
