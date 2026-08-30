import { Loader2Icon, type LucideIcon, type LucideProps } from 'lucide-react';
import { useLingui } from '@ok-app/shims/lingui-react-macro';
import { cn } from '@ok-app/lib/utils';

export function Spinner({
  className,
  icon: Icon = Loader2Icon,
  ...props
}: LucideProps & { icon?: LucideIcon }) {
  const { t } = useLingui();

  return (
    <Icon
      role="status"
      aria-label={t`Loading`}
      className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
