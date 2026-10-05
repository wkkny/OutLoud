import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { cn } from 'cn'

const ContextMenu = ContextMenuPrimitive.Root

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" className={cn('w-full', className)} {...props} />
}

function ContextMenuContent({ className, children, ...props }: ContextMenuPrimitive.Popup.Props) {
  return <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Positioner className="z-50">
      <ContextMenuPrimitive.Popup data-slot="context-menu-content" className={cn('min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none', className)} {...props}>
        {children}
      </ContextMenuPrimitive.Popup>
    </ContextMenuPrimitive.Positioner>
  </ContextMenuPrimitive.Portal>
}

function ContextMenuItem({ className, variant = 'default', ...props }: ContextMenuPrimitive.Item.Props & { variant?: 'default' | 'destructive' }) {
  return <ContextMenuPrimitive.Item data-slot="context-menu-item" data-variant={variant} className={cn('flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 text-xs outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[variant=destructive]:text-destructive', className)} {...props} />
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger }
