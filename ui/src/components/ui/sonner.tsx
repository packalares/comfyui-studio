import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Minimal Sonner wrapper matching the shadcn docs reference — plain white
 * toast cards with a subtle shadow, no rich-color tinting, no close X, no
 * stacked-expand behaviour. Sized down a bit from the Sonner default so
 * toasts feel proportional to the rest of the app's typography.
 *
 * Sonner exposes width via the `--width` CSS var; everything else (padding,
 * font size) we trim through classNames.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={{ '--width': '320px' } as React.CSSProperties}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:!p-3 group-[.toaster]:!text-[12px] group-[.toaster]:!gap-2',
          title: 'group-[.toast]:text-[12px] group-[.toast]:font-medium',
          description: 'group-[.toast]:text-[11px]',
          actionButton:
            'group-[.toast]:bg-brand group-[.toast]:text-brand-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
