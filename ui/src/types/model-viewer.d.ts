// Global JSX augmentation for the `<model-viewer>` custom element shipped
// by `@google/model-viewer`. The package registers the element via side
// effects at import time; this declaration lets TypeScript accept the tag
// and its minimal attribute surface we actually use. Full attribute
// coverage lives in the upstream docs — only the props we touch are typed
// here to keep the `expect-error` footprint tiny.

declare namespace JSX {
  interface IntrinsicElements {
    'model-viewer': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        alt?: string;
        'camera-controls'?: string;
        'auto-rotate'?: string;
        'interaction-prompt'?: string;
        'environment-image'?: string;
        'tone-mapping'?: string;
        exposure?: string;
        'shadow-intensity'?: string;
        'shadow-softness'?: string;
      },
      HTMLElement
    >;
  }
}
