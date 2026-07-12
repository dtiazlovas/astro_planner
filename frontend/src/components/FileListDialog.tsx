import { useState } from 'react'

interface Props {
  title: string
  files: string[]
  onClose: () => void
}

// Plain-text file list with one-click copy (e.g. subs excluded by the
// quality limit, for use in other tools).
export default function FileListDialog({ title, files, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const text = files.join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable — the list stays selectable as a fallback.
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '48rem' }}>
        <div className="modal-dialog__header">
          <span className="modal-dialog__title">{title}</span>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <pre style={{
          maxHeight: '50vh', overflow: 'auto', margin: 0,
          background: '#0f0f1e', border: '1px solid #2a2a48', borderRadius: 6,
          padding: '0.75rem', fontSize: '0.8rem', lineHeight: 1.5, userSelect: 'text',
        }}>
          {text || '—'}
        </pre>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={copy} disabled={!files.length}>
            {copied ? '✓ Copied' : `Copy ${files.length} file name${files.length !== 1 ? 's' : ''}`}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
