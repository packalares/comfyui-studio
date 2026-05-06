// MCP Servers settings section — list, add, edit, delete, test.
// Renders as a Card matching the existing Settings page sections.

import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, Network } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Badge } from '../ui/badge';
import ConfirmDialog from '../modals/ConfirmDialog';
import McpServerCard from './McpServerCard';
import McpServerFormModal from './McpServerFormModal';
import { getMcpServers, deleteMcpServer, type McpServerConfig } from '../../api/mcp';

export default function McpServersSection() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpServerConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getMcpServers();
      setServers(list);
      setError(null);
    } catch (err) {
      setError('Could not load MCP servers');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchServers(); }, [fetchServers]);

  const handleSaved = (saved: McpServerConfig) => {
    setServers(prev => {
      const idx = prev.findIndex(s => s.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
  };

  const handleStatusChange = (_id: string, updated: McpServerConfig) => {
    setServers(prev => prev.map(s => s.id === updated.id ? updated : s));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMcpServer(deleteTarget.id);
      setServers(prev => prev.filter(s => s.id !== deleteTarget.id));
      toast.success(`${deleteTarget.name} removed`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error('Failed to delete server', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  };

  const connectedCount = servers.filter(s => s.status?.state === 'connected').length;

  return (
    <>
      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Network className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">MCP Servers</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                External tool providers connected over MCP.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!loading && servers.length > 0 && (
              <Badge variant="slate">
                <Network className="h-3 w-3" />
                {connectedCount}/{servers.length} connected
              </Badge>
            )}
            <ButtonGroup>
              <Button
                variant="secondary"
                onClick={() => void fetchServers()}
                disabled={loading}
                aria-label="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add server
              </Button>
            </ButtonGroup>
          </div>
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
                <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : servers.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Network className="h-6 w-6" />
              </div>
              <p className="text-sm text-muted-foreground max-w-sm">
                No MCP servers connected. Add one to expose its tools (search, scraping, docs, etc.)
                to the chat LLM.
              </p>
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add server
              </Button>
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-hidden">
              {servers.map(server => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  onEdit={s => setEditTarget(s)}
                  onDelete={s => setDeleteTarget(s)}
                  onStatusChange={handleStatusChange}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add modal */}
      <McpServerFormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={handleSaved}
      />

      {/* Edit modal */}
      <McpServerFormModal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        server={editTarget ?? undefined}
        onSaved={handleSaved}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        description="This removes the server configuration permanently. The server process itself is not affected."
        confirmLabel="Delete"
        confirmTone="danger"
        busy={deleting}
        onConfirm={handleDelete}
      />
    </>
  );
}
