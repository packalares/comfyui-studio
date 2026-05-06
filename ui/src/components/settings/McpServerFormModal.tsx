// Add / Edit MCP server form modal.
// Transport segmented control: stdio (command + args) | http (url + bearer token).

import { useState, useEffect } from 'react';
import { Save, X } from 'lucide-react';
import { toast } from 'sonner';
import AppModal from '../modals/AppModal';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import InputField from '../forms/InputField';
import { type McpServerConfig, type McpServerInput, addMcpServer, updateMcpServer } from '../../api/mcp';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pass a server to edit; omit for add. */
  server?: McpServerConfig;
  onSaved: (server: McpServerConfig) => void;
}

const EMPTY: McpServerInput = {
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  enabled: true,
};

export default function McpServerFormModal({ open, onClose, server, onSaved }: Props) {
  const isEdit = Boolean(server);
  const [form, setForm] = useState<McpServerInput>(EMPTY);
  const [argsText, setArgsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Seed form from server on open
  useEffect(() => {
    if (open) {
      if (server) {
        setForm({
          name: server.name,
          transport: server.transport,
          command: server.command ?? '',
          args: server.args ?? [],
          url: server.url ?? '',
          auth: server.auth,
          enabled: server.enabled,
        });
        setArgsText((server.args ?? []).join('\n'));
      } else {
        setForm(EMPTY);
        setArgsText('');
      }
      setErrors({});
    }
  }, [open, server]);

  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => { const n = { ...e }; delete n[key]; return n; });
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (form.transport === 'stdio' && !form.command?.trim()) errs.command = 'Command is required';
    if (form.transport === 'http' && !form.url?.trim()) errs.url = 'URL is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      const payload: McpServerInput = {
        ...form,
        name: form.name.trim(),
        args: argsText.split('\n').map(s => s.trim()).filter(Boolean),
        command: form.transport === 'stdio' ? form.command?.trim() : undefined,
        url: form.transport === 'http' ? form.url?.trim() : undefined,
        auth: form.transport === 'http' && form.auth?.token?.trim()
          ? { type: 'bearer', token: form.auth.token.trim() }
          : undefined,
      };
      const saved = isEdit && server
        ? await updateMcpServer(server.id, payload)
        : await addMcpServer(payload);
      toast.success(isEdit ? 'Server updated' : 'Server added');
      onSaved(saved);
      onClose();
    } catch (err) {
      toast.error(isEdit ? 'Failed to update server' : 'Failed to add server', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit MCP server' : 'Add MCP server'}
      size="sm"
      scrollBody={false}
      disableClose={busy}
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            <Save className="h-3.5 w-3.5" />
            {isEdit ? 'Update' : 'Add'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Name */}
        <InputField
          label="Name"
          value={form.name}
          onChange={v => set('name', v)}
          placeholder="My MCP server"
          monospace={false}
          invalid={Boolean(errors.name)}
          helper={errors.name}
          disabled={busy}
        />

        {/* Transport segmented control */}
        <div>
          <label className="field-label mb-1 block">Transport</label>
          <div className="tab-strip">
            {(['stdio', 'http'] as const).map(t => (
              <button
                key={t}
                type="button"
                className={`tab-strip-item ${form.transport === t ? 'is-active' : ''}`}
                onClick={() => set('transport', t)}
                disabled={busy}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* stdio fields */}
        {form.transport === 'stdio' && (
          <>
            <InputField
              label="Command"
              value={form.command ?? ''}
              onChange={v => set('command', v)}
              placeholder="npx @modelcontextprotocol/server-filesystem"
              invalid={Boolean(errors.command)}
              helper={errors.command}
              disabled={busy}
            />
            <div>
              <label className="field-label mb-1 block">Args (one per line)</label>
              <textarea
                className="field-textarea w-full min-h-[72px]"
                value={argsText}
                onChange={e => setArgsText(e.target.value)}
                placeholder={'/path/to/dir\n--flag'}
                disabled={busy}
                spellCheck={false}
              />
            </div>
          </>
        )}

        {/* http fields */}
        {form.transport === 'http' && (
          <>
            <InputField
              label="URL"
              value={form.url ?? ''}
              onChange={v => set('url', v)}
              placeholder="https://mcp.example.com"
              invalid={Boolean(errors.url)}
              helper={errors.url}
              disabled={busy}
            />
            <InputField
              label="Bearer token (optional)"
              type="password"
              value={form.auth?.token ?? ''}
              onChange={v => set('auth', v ? { type: 'bearer', token: v } : undefined)}
              placeholder="Leave blank if not required"
              disabled={busy}
            />
          </>
        )}

        {/* Enabled toggle */}
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-foreground">Enabled</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Disabled servers are stored but not connected on startup.
            </p>
          </div>
          <Switch
            checked={form.enabled}
            disabled={busy}
            onCheckedChange={v => set('enabled', v)}
          />
        </div>
      </div>
    </AppModal>
  );
}
