// API key management page — create, list, revoke.
// Integrated as a tab inside the main Settings page.

import { useState, useEffect, useCallback } from 'react';
import { Key, Copy, Check, Plus, Trash2, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { SCOPES, type Scope } from '@server/lib/auth/scopes';
import type { ApiKey } from '@server/contracts/auth.contract';
import { createApiKey, listApiKeys, revokeApiKey } from '../../api/auth.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader } from '../../components/ui/card.js';
import AppModal from '../../components/modals/AppModal.js';
import ConfirmDialog from '../../components/modals/ConfirmDialog.js';
import { useTransientFlag } from '../../hooks/useTransientFlag.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const SCOPE_VARIANT: Record<string, 'brand' | 'warning' | 'danger' | 'neutral'> = {
  'admin:all': 'danger',
  'admin:keys': 'warning',
};

function ScopeChip({ scope }: { scope: Scope }) {
  const variant = SCOPE_VARIANT[scope] ?? 'neutral';
  return <Badge variant={variant} className="font-mono text-[10px]">{scope}</Badge>;
}

// ── Create-key modal ──────────────────────────────────────────────────────────

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (key: ApiKey) => void;
}

function CreateModal({ open, onClose, onCreated }: CreateModalProps) {
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<Scope>>(new Set());
  const [expiry, setExpiry] = useState<'none' | '30d' | '90d' | 'custom'>('none');
  const [customDate, setCustomDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [plainSecret, setPlainSecret] = useState<string | null>(null);
  const [copied, markCopied] = useTransientFlag(2000);

  // Reset form on open.
  useEffect(() => {
    if (open) {
      setName('');
      setSelectedScopes(new Set());
      setExpiry('none');
      setCustomDate('');
      setPlainSecret(null);
    }
  }, [open]);

  const toggleScope = (s: Scope) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const expiresAtIso = (): string | null => {
    if (expiry === 'none') return null;
    if (expiry === '30d') return new Date(Date.now() + 30 * 86400_000).toISOString();
    if (expiry === '90d') return new Date(Date.now() + 90 * 86400_000).toISOString();
    if (expiry === 'custom' && customDate) return new Date(customDate).toISOString();
    return null;
  };

  const canSubmit = name.trim().length > 0 && selectedScopes.size > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const result = await createApiKey({
        name: name.trim(),
        scopes: [...selectedScopes],
        expiresAt: expiresAtIso(),
      });
      setPlainSecret(result.plain);
      onCreated(result);
    } catch (err) {
      toast.error('Failed to create key', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!plainSecret) return;
    try {
      await navigator.clipboard.writeText(plainSecret);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = plainSecret;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    markCopied();
  };

  if (plainSecret !== null) {
    return (
      <AppModal
        open={open}
        onClose={onClose}
        title="Key created"
        icon={<Key className="w-4 h-4 text-brand" />}
        size="sm"
        scrollBody={false}
        footer={
          <Button className="ml-auto" onClick={onClose}>Done</Button>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            <ShieldAlert className="inline-block h-3.5 w-3.5 mr-1 align-text-bottom" />
            This is the only time you'll see this secret. Save it now.
          </div>
          <div className="rounded-md border bg-muted px-3 py-2">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Secret key</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all font-mono text-xs text-foreground">{plainSecret}</code>
              <Button variant="ghost" size="icon" onClick={() => void handleCopy()} title="Copy">
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>
      </AppModal>
    );
  }

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Create API key"
      icon={<Key className="w-4 h-4 text-brand" />}
      size="sm"
      disableClose={busy}
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit || busy}>
            {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-1">
          <label className="field-label">Name</label>
          <input
            className="field-input w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm"
            placeholder="e.g. My automation script"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Scopes */}
        <div className="space-y-1.5">
          <label className="field-label">Scopes</label>
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((s) => {
              const active = selectedScopes.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleScope(s)}
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors cursor-pointer ${
                    active
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border bg-muted text-muted-foreground hover:border-brand/50 hover:text-foreground'
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
          {selectedScopes.size === 0 && (
            <p className="text-[11px] text-muted-foreground">Select at least one scope.</p>
          )}
        </div>

        {/* Expiry */}
        <div className="space-y-1">
          <label className="field-label">Expires</label>
          <div className="flex flex-wrap gap-2">
            {(['none', '30d', '90d', 'custom'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setExpiry(v)}
                className={`rounded border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                  expiry === v
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border bg-muted text-muted-foreground hover:border-brand/50'
                }`}
              >
                {v === 'none' ? 'Never' : v === 'custom' ? 'Custom…' : v}
              </button>
            ))}
          </div>
          {expiry === 'custom' && (
            <input
              type="date"
              className="mt-1.5 w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm"
              value={customDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setCustomDate(e.target.value)}
            />
          )}
        </div>
      </div>
    </AppModal>
  );
}

// ── Key list row ──────────────────────────────────────────────────────────────

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (id: string) => void }) {
  const isRevoked = apiKey.revokedAt !== null;
  const isExpired = apiKey.expiresAt !== null && new Date(apiKey.expiresAt) < new Date();

  return (
    <div className={`flex items-start gap-3 px-4 py-3 hover:bg-muted transition-colors ${isRevoked || isExpired ? 'opacity-50' : ''}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{apiKey.name}</span>
          <code className="font-mono text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">{apiKey.prefix}_…</code>
          {isRevoked && <Badge variant="danger" className="text-[9px]">Revoked</Badge>}
          {!isRevoked && isExpired && <Badge variant="warning" className="text-[9px]">Expired</Badge>}
        </div>
        <div className="flex flex-wrap gap-1">
          {apiKey.scopes.map((s) => <ScopeChip key={s} scope={s} />)}
        </div>
        <div className="flex gap-4 text-[11px] text-muted-foreground">
          <span>Created {fmt(apiKey.createdAt)}</span>
          <span>Last used: {fmtRelative(apiKey.lastUsedAt)}</span>
          {apiKey.expiresAt && <span>Expires {fmt(apiKey.expiresAt)}</span>}
        </div>
      </div>
      {!isRevoked && (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Revoke key"
          onClick={() => onRevoke(apiKey.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revoking2, setRevoking2] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listApiKeys();
      setKeys(data);
    } catch (err) {
      toast.error('Failed to load API keys', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreated = (key: ApiKey) => {
    setKeys((prev) => [key, ...prev]);
  };

  const handleConfirmRevoke = async () => {
    if (!revoking) return;
    setRevoking2(true);
    try {
      const updated = await revokeApiKey(revoking);
      setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
      toast.success('Key revoked');
    } catch (err) {
      toast.error('Failed to revoke key', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevoking2(false);
      setRevoking(null);
    }
  };

  const revokingKey = keys.find((k) => k.id === revoking);

  return (
    <>
      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Key className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">API Keys</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Bearer tokens for external API access. Secrets are shown once at creation.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="icon" onClick={() => void load()} title="Refresh" aria-label="Refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              Create Key
            </Button>
          </div>
        </CardHeader>

        {loading ? (
          <CardContent>
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          </CardContent>
        ) : keys.length === 0 ? (
          <CardContent>
            <div className="empty-box">No API keys yet. Create one to get started.</div>
          </CardContent>
        ) : (
          <div className="divide-y border-t">
            {keys.map((k) => (
              <KeyRow key={k.id} apiKey={k} onRevoke={(id) => setRevoking(id)} />
            ))}
          </div>
        )}

        {!loading && keys.length > 0 && (
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              {keys.filter((k) => k.revokedAt === null).length} active key{keys.filter((k) => k.revokedAt === null).length !== 1 ? 's' : ''}
            </p>
          </CardFooter>
        )}
      </Card>

      <CreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={handleCreated}
      />

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revokingKey?.name ?? 'key'}"?`}
        description="The key will stop working immediately. This cannot be undone."
        confirmLabel="Revoke"
        confirmTone="danger"
        busy={revoking2}
        onConfirm={handleConfirmRevoke}
      />
    </>
  );
}
