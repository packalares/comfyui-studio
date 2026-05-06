// Studio MCP Server — expose Studio catalog/tools to external agents.
// Disabled state → big Enable button.
// Enabled state → endpoint URL, masked token (copy/reveal), Regenerate, Disable.

import { useState, useEffect, useCallback } from 'react';
import { Copy, Check, Eye, EyeOff, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import ConfirmDialog from '../modals/ConfirmDialog';
import {
  getStudioMcpStatus,
  enableStudioMcp,
  disableStudioMcp,
} from '../../api/mcp';

/* ---- copy button ---- */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="ghost" size="icon" title="Copy" onClick={copy}>
      {copied
        ? <Check className="h-3.5 w-3.5 text-success" />
        : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

/* ---- read-only field with copy ---- */

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <label className="field-label">{label}</label>
      <div className="field-wrap py-1">
        <input
          readOnly
          value={value}
          className="field-input font-mono text-xs"
          onFocus={e => e.target.select()}
        />
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/* ---- token field — masked, eye toggle, copy ---- */

function TokenField({ token }: { token: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-1">
      <label className="field-label">Token</label>
      <div className="field-wrap py-1">
        <input
          readOnly
          type={revealed ? 'text' : 'password'}
          value={token}
          className="field-input font-mono text-xs"
          onFocus={e => e.target.select()}
        />
        <Button
          variant="ghost"
          size="icon"
          title={revealed ? 'Hide token' : 'Reveal token'}
          onClick={() => setRevealed(r => !r)}
        >
          {revealed
            ? <EyeOff className="h-3.5 w-3.5" />
            : <Eye className="h-3.5 w-3.5" />}
        </Button>
        <CopyButton text={token} />
      </div>
    </div>
  );
}

/* ---- section ---- */

export default function StudioMcpServerSection() {
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // confirm dialogs
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const endpointUrl = `${window.location.origin}/api/mcp`;

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getStudioMcpStatus();
      setEnabled(data.enabled);
      setToken(data.token);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.includes('Not Found')) {
        setError('Backend not available yet — check back after deploy.');
      } else {
        setError('Could not load Studio MCP status.');
        console.error(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  const handleEnable = async () => {
    setBusy(true);
    try {
      const data = await enableStudioMcp();
      setEnabled(data.enabled);
      setToken(data.token);
      toast.success('Studio MCP server enabled');
    } catch (err) {
      toast.error('Failed to enable', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    setBusy(true);
    try {
      const data = await enableStudioMcp();
      setEnabled(data.enabled);
      setToken(data.token);
      toast.success('Token regenerated — update any connected agents');
    } catch (err) {
      toast.error('Failed to regenerate token', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setConfirmRegen(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await disableStudioMcp();
      setEnabled(false);
      setToken(null);
      toast.success('Studio MCP server disabled');
    } catch (err) {
      toast.error('Failed to disable', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setConfirmDisable(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Server className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">
                Studio MCP Server
              </h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Expose Studio&apos;s catalog and tools to external agents (Claude Desktop, etc.).
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void fetchStatus()}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>

        <CardContent className="space-y-3">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : !enabled ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground max-w-sm">
                Enable the Studio MCP server to let external agents (Claude Desktop, Cursor, etc.)
                access Studio&apos;s catalog, templates, and tools via the MCP protocol.
              </p>
              <Button onClick={handleEnable} disabled={busy}>
                {busy
                  ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  : <Server className="h-3.5 w-3.5" />}
                Enable Studio MCP Server
              </Button>
            </div>
          ) : (
            <>
              <ReadOnlyField label="Endpoint URL" value={endpointUrl} />
              {token && <TokenField token={token} />}
            </>
          )}
        </CardContent>
        {enabled && !loading && (
          <CardFooter className="justify-end">
            <ButtonGroup>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmRegen(true)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Regenerate token
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmDisable(true)}
              >
                Disable
              </Button>
            </ButtonGroup>
          </CardFooter>
        )}
      </Card>

      {/* Regenerate confirm */}
      <ConfirmDialog
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        title="Regenerate token?"
        description="This will invalidate the current token immediately. Any connected agents using the old token will stop working until you update them."
        confirmLabel="Regenerate"
        confirmTone="danger"
        busy={busy}
        onConfirm={handleRegenerate}
      />

      {/* Disable confirm */}
      <ConfirmDialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title="Disable Studio MCP Server?"
        description="External agents will lose access immediately. You can re-enable it at any time — a new token will be issued."
        confirmLabel="Disable"
        confirmTone="danger"
        busy={busy}
        onConfirm={handleDisable}
      />
    </>
  );
}
