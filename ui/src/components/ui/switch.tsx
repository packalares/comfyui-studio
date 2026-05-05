import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils';

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'md';
};

const sizes = {
  sm: { root: 'h-4 w-7', thumb: 'h-3 w-3 data-[state=checked]:translate-x-3' },
  md: { root: 'h-5 w-9', thumb: 'h-4 w-4 data-[state=checked]:translate-x-4' },
} as const;

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, size = 'sm', ...props }, ref) => {
  const s = sizes[size];
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-brand data-[state=unchecked]:bg-input',
        s.root,
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-card shadow-sm ring-0 transition-transform data-[state=unchecked]:translate-x-0',
          s.thumb
        )}
      />
    </SwitchPrimitive.Root>
  );
});
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
