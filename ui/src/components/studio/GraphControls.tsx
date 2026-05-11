import { Panel, useReactFlow, useViewport } from 'reactflow';
import { Minus, Plus, Maximize2, Hand } from 'lucide-react';

const FIT_OPTS = { padding: 0.15, maxZoom: 1.1, duration: 300 };

/** Floating bottom-center toolbar — zoom out / level / zoom in, then a pan
 *  affordance and a fit-to-view button. Replaces React Flow's default
 *  (vertical, bottom-left) Controls. Must render inside <ReactFlow>. */
export default function GraphControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();

  return (
    <Panel position="bottom-center">
      <div className="wf-toolbar">
        <button type="button" aria-label="Zoom out" className="wf-toolbar-btn" onClick={() => zoomOut({ duration: 150 })}>
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="wf-toolbar-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="wf-toolbar-btn" onClick={() => zoomIn({ duration: 150 })}>
          <Plus className="h-3.5 w-3.5" />
        </button>

        <span className="wf-toolbar-divider" />

        <span className="wf-toolbar-pan" title="Drag the canvas to pan">
          <Hand className="h-3.5 w-3.5" />
        </span>
        <button type="button" aria-label="Fit view" className="wf-toolbar-btn" onClick={() => fitView(FIT_OPTS)}>
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </Panel>
  );
}
