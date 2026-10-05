import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from 'cn'

const Select = SelectPrimitive.Root

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn('flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50', className)} {...props}>
    <span className="min-w-0 truncate">{children}</span>
    <SelectPrimitive.Icon className="shrink-0 text-muted-foreground"><ChevronDown className="size-4" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
}

function SelectValue(props: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectContent({ className, children, sideOffset = 4, align, ...props }: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, 'align' | 'sideOffset'>) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner align={align} sideOffset={sideOffset} className="z-50">
      <SelectPrimitive.Popup data-slot="select-content" className={cn('max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none', className)} {...props}>
        <SelectPrimitive.List>{children}</SelectPrimitive.List>
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('py-1', className)} {...props} />
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn('relative flex min-h-8 w-full cursor-default items-center rounded-sm px-2 pr-8 text-xs outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground', className)} {...props}>
    <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center justify-center"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue }
