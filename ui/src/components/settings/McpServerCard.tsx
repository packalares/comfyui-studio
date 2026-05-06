// Single MCP server row card — name, transport badge, status pill, actions.

import { useState } from 'react';
import { Pencil, Trash2, FlaskConical, Terminal, Globe } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { testMcpServer, type McpServerConfig } from '../../api/mcp';

interface Props {
  server: McpServerConfig;
  onEdit: (server: McpServerConfig) => void;
  onDelete: (server: McpServerConfig) => void;
  onStatusChange: (id: string, updated: McpServerConfig) => void;
}

function StatusPill({ status }: { status?: McpServerConfig['status'] }) {
  if (!status) {
    return (
      <Badge variant="slate" className="text-[10px]">
        Unknown
      </Badge>
    );
  }
  if (status.state === 'connected') {
    return (
      <Badge variant="emerald" className="text-[10px]">
        Connected{status.toolCount != null ? ` · ${status.toolCount} tools` : ''}
      </Badge>
    );
  }
  if (status.state === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="rose" className="cursor-help text-[10px]">
            Error
          </Badge>
        </TooltipTrigger>
        {status.lastError && (
          <TooltipContent className="max-w-xs">{status.lastError}</TooltipContent>
        )}
      </Tooltip>
    );
  }
  return (
    <Badge variant="slate" className="text-[10px]">
      Disconnected
    </Badge>
  );
}

export default function McpServerCard({ server, onEdit, onDelete, onStatusChange }: Props) {
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testMcpServer(server.id);
      if (result.ok) {
        toast.success(`${server.name} — OK${result.toolCount != null ? ` · ${result.toolCount} tools` : ''}`);
        onStatusChange(server.id, {
          ...server,
          status: { state: 'connected', toolCount: result.toolCount },
        });
      } else {
        toast.error(`${server.name} — Test failed`, { description: result.error });
        onStatusChange(server.id, {
          ...server,
          status: { state: 'error', lastError: result.error },
        });
      }
    } catch (err) {
      toast.error('Test request failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const TransportIcon = server.transport === 'http' ? Globe : Terminal;

  return (
    <div className="group flex items-center gap-3 px-4 py-3 hover:bg-muted transition-colors">
      {/* Transport icon */}
      <TransportIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

      {/* Name + badges */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{server.name}</span>
          <Badge variant="slate" className="text-[10px]">
            {server.transport}
          </Badge>
          {!server.enabled && (
            <Badge variant="amber" className="text-[10px]">
              Disabled
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {server.transport === 'http' ? server.url : server.command}
        </div>
      </div>

      {/* Status */}
      <div className="shrink-0">
        <StatusPill status={server.status} />
      </div>

      {/* Actions — segmented Test / Edit / Delete button group */}
      <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <ButtonGroup size="sm">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Test connection"
                disabled={testing}
                onClick={handleTest}
              >
                <FlaskConical className={`h-3.5 w-3.5 ${testing ? 'animate-pulse' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Test connection</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Edit"
                onClick={() => onEdit(server)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Delete"
                onClick={() => onDelete(server)}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>
    </div>
  );
}
