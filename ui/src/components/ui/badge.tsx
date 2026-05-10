import { type ComponentType, type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export type BadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'brand'
  | 'neutral'
  | 'secondary'
  | 'overlay';

export type BadgeTreatment = 'soft' | 'solid';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  treatment?: BadgeTreatment;
  /** Optional left-side icon. Pass the component reference (`icon={Wand2}`),
   *  not a pre-rendered element. Sized to 12px to fit the badge height. */
  icon?: ComponentType<{ className?: string }>;
}

export function Badge({
  variant = 'neutral',
  treatment = 'soft',
  icon: Icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'badge',
        `badge-${variant}`,
        treatment === 'solid' && 'badge-solid',
        className,
      )}
      {...rest}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}
