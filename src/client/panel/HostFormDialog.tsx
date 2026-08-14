/** Host create/edit dialog. Secrets are only sent on create; updates keep
 *  the stored secrets when auth is omitted (matches the host API contract). */

import { useState } from 'react'
import type { FormEvent } from 'react'
import type { HostPayload, SshHostSummary } from '../../protocol'
import type { RemoteIdeApi } from '../api'
import { tt } from './helpers'
import { ensurePanelCss, panelClasses as css } from './panel-css'

export interface HostFormDialogProps {
  /** Existing host when editing; undefined when creating. */
  host?: SshHostSummary
  api: RemoteIdeApi
  /** Dictionary accessor (locale-aware). */
  t: (key: string) => string
  onSaved: () => void
  onClose: () => void
}

/** One form field value. */
interface FormState {
  alias: string
  host: string
  port: string
  user: string
  authKind: 'password' | 'key'
  password: string
  keyPath: string
  passphrase: string
  proxyJump: string
  description: string
  tags: string
}

export function HostFormDialog(props: HostFormDialogProps): React.ReactElement {
  const { host, api, t, onSaved, onClose } = props
  const [form, setForm] = useState<FormState>(() => ({
    alias: host?.alias ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    user: host?.user ?? '',
    authKind: host?.auth ?? 'password',
    password: '',
    keyPath: host?.auth === 'key' ? (host as SshHostSummary & { keyPath?: string }).keyPath ?? '~/.ssh/id_ed25519' : '~/.ssh/id_ed25519',
    passphrase: '',
    proxyJump: host?.proxyJump.join(', ') ?? '',
    description: host?.description ?? '',
    tags: host?.tags.join(', ') ?? '',
  }))
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const set = (field: keyof FormState, value: string): void => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    setSaving(true)
    try {
      const payload: HostPayload = {
        alias: form.alias.trim(),
        host: form.host.trim(),
        port: Number.parseInt(form.port, 10) || 22,
        user: form.user.trim(),
        proxyJump: form.proxyJump.split(',').map(s => s.trim()).filter(s => s !== ''),
        description: form.description.trim() || undefined,
        tags: form.tags.split(',').map(s => s.trim()).filter(s => s !== ''),
      }
      if (form.authKind === 'password') {
        // Only include the password when provided (edits keep the old one).
        if (host === undefined || form.password !== '') {
          payload.auth = { kind: 'password', password: form.password }
        }
      } else {
        payload.auth = {
          kind: 'key',
          keyPath: form.keyPath.trim(),
          passphrase: form.passphrase || undefined,
        }
      }
      if (host === undefined) await api.createHost(payload)
      else await api.updateHost(host.alias, payload)
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaving(false)
    }
  }

  return (
    <div className={css.overlay}>
      <form className={css.dialog} onSubmit={submit}>
        <h3 className={css.dialogTitle}>
          {host === undefined ? t('host.form.titleNew') : t('host.form.titleEdit')}
        </h3>

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.alias')} *</label>
          <input
            className={css.formInput}
            value={form.alias}
            onChange={e => set('alias', e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className={css.formRowInline}>
          <div className={css.formRow}>
            <label className={css.formLabel}>{t('host.form.host')} *</label>
            <input
              className={css.formInput}
              value={form.host}
              onChange={e => set('host', e.target.value)}
              placeholder="example.com / 1.2.3.4"
              required
            />
          </div>
          <div className={css.formRow} style={{ width: 90 }}>
            <label className={css.formLabel}>{t('host.form.port')}</label>
            <input
              className={css.formInput}
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={e => set('port', e.target.value)}
            />
          </div>
        </div>

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.user')} *</label>
          <input
            className={css.formInput}
            value={form.user}
            onChange={e => set('user', e.target.value)}
            placeholder="root"
            required
          />
        </div>

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.authKind')}</label>
          <select
            className={css.formSelect}
            value={form.authKind}
            onChange={e => set('authKind', e.target.value as 'password' | 'key')}
          >
            <option value="password">Password</option>
            <option value="key">SSH Key</option>
          </select>
        </div>

        {form.authKind === 'password' && (
          <div className={css.formRow}>
            <label className={css.formLabel}>
              {t('host.form.password')}{host === undefined ? ' *' : ''}
            </label>
            <input
              className={css.formInput}
              type="password"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              placeholder={host === undefined ? undefined : '•••••••• (keep)'}
              required={host === undefined}
            />
          </div>
        )}

        {form.authKind === 'key' && (
          <>
            <div className={css.formRow}>
              <label className={css.formLabel}>{t('host.form.keyPath')}</label>
              <input
                className={css.formInput}
                value={form.keyPath}
                onChange={e => set('keyPath', e.target.value)}
                placeholder="~/.ssh/id_ed25519"
              />
            </div>
            <div className={css.formRow}>
              <label className={css.formLabel}>{t('host.form.passphrase')}</label>
              <input
                className={css.formInput}
                type="password"
                value={form.passphrase}
                onChange={e => set('passphrase', e.target.value)}
              />
            </div>
          </>
        )}

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.proxyJump')}</label>
          <input
            className={css.formInput}
            value={form.proxyJump}
            onChange={e => set('proxyJump', e.target.value)}
          />
        </div>

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.description')}</label>
          <input
            className={css.formInput}
            value={form.description}
            onChange={e => set('description', e.target.value)}
          />
        </div>

        <div className={css.formRow}>
          <label className={css.formLabel}>{t('host.form.tags')}</label>
          <input
            className={css.formInput}
            value={form.tags}
            onChange={e => set('tags', e.target.value)}
          />
        </div>

        {error !== undefined && <div className={css.formError}>{error}</div>}

        <div className={css.formActions}>
          <button type="button" className={css.btn} onClick={onClose} disabled={saving}>
            {t('host.form.cancel')}
          </button>
          <button type="submit" className={`${css.btn} ${css.btnPrimary}`} disabled={saving}>
            {t('host.form.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

void tt
