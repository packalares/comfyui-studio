import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-[5px] w-full grow overflow-hidden rounded-full bg-slate-200">
      <SliderPrimitive.Range className="absolute h-full bg-teal-500" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-2.5 w-2.5 rounded-full border border-teal-600 bg-white shadow-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-teal-500 disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
