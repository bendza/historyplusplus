// Small shared components. Plain h() calls: tsconfig has no JSX setting and we don't own it.
import { h, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { faviconUrl } from './api';

export function Favicon({ url }: { url: string }) {
  const src = faviconUrl(url);
  if (src) return h('img', { class: 'favicon', src, width: 16, height: 16, alt: '', loading: 'lazy', decoding: 'async' });
  const { letter, hue } = letterTile(url);
  return h('span', { class: 'favicon favicon-letter', style: { '--hue': hue }, 'aria-hidden': 'true' }, letter);
}

/** First letter of the site name and a stable hue, for browsers without a favicon API. */
export function letterTile(url: string): { letter: string; hue: number } {
  const host = url.replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').split(/[/?#]/)[0] ?? '';
  let hash = 0;
  for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return { letter, hue: Math.abs(hash) % 360 };
}

/** A path or command with a Copy button (clipboard API, else select the text for ⌘C). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: MouseEvent) => {
    const input = (e.currentTarget as HTMLElement).parentElement?.querySelector('input');
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      input?.focus();
      input?.select();
    }
  };
  return h(
    'div',
    { class: 'copy-field' },
    h('input', { type: 'text', readOnly: true, value, 'aria-label': label, spellcheck: false, onFocus: (e: FocusEvent) => (e.currentTarget as HTMLInputElement).select() }),
    h('button', { type: 'button', class: 'btn btn-small', onClick: copy, 'aria-live': 'polite' }, copied ? 'Copied' : 'Copy'),
  );
}

/** Labelled progress bar. `value` null = indeterminate. */
export function Meter({ value, label, busy = false }: { value: number | null; label: string; busy?: boolean }) {
  return h(
    'div',
    { class: 'meter', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value ?? undefined },
    h('span', { class: `meter-fill${busy ? ' meter-busy' : ''}${value == null ? ' meter-indet' : ''}`, style: { width: `${value ?? 30}%` } }),
  );
}

/** Switch-style checkbox row: title, description, and the control on the right. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; title: string; desc?: ComponentChildren; disabled?: boolean }) {
  return h(
    'label',
    { class: 'switch-row' },
    h('span', { class: 'switch-text' }, h('strong', null, props.title), props.desc ? h('span', { class: 'muted block' }, props.desc) : null),
    h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: props.checked, disabled: props.disabled, onChange: (e: Event) => props.onChange((e.currentTarget as HTMLInputElement).checked) }),
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return h(
    'div',
    { class: 'banner banner-error', role: 'alert' },
    h('strong', null, 'Something went wrong. '),
    h('span', null, msg),
    onRetry ? h('button', { type: 'button', class: 'btn btn-small', onClick: onRetry }, 'Retry') : null,
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return h('span', { class: 'spinner', role: 'status' }, h('span', { class: 'sr-only' }, label));
}

/**
 * Two-step destructive action rendered in the page (never window.confirm).
 * First click reveals a prompt with Confirm/Cancel; Confirm runs `onConfirm`.
 */
export function ConfirmButton(props: {
  label: string;
  prompt: ComponentChildren;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!open) {
    return h(
      'button',
      { type: 'button', class: `btn${props.danger ? ' btn-danger-outline' : ''}`, onClick: () => (setErr(null), setOpen(true)) },
      props.label,
    );
  }
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await props.onConfirm();
      setOpen(false);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return h(
    'div',
    { class: 'confirm', role: 'group', 'aria-label': props.label },
    h('div', { class: 'confirm-prompt' }, props.prompt),
    h(
      'div',
      { class: 'confirm-actions' },
      h(
        'button',
        { type: 'button', class: `btn ${props.danger ? 'btn-danger' : 'btn-primary'}`, disabled: busy, onClick: run, autoFocus: true },
        busy ? 'Working…' : (props.confirmLabel ?? 'Confirm'),
      ),
      h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => setOpen(false) }, 'Cancel'),
    ),
    err ? h(ErrorBanner, { error: err }) : null,
  );
}

/** Trigger a browser download for in-memory data. */
export function downloadBlob(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
