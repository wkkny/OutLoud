import { AudioLines, MessageSquare, Plus } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, useSidebar } from '@/components/ui/sidebar'
import type { Conversation, ConversationLibrary } from '@/lib/conversations'

type Props = { library: ConversationLibrary; list: Conversation[]; selectedId: string | null; connected: boolean; loading: boolean; creating: boolean; onCreate: () => void }

export function AppSidebar({ library, list, selectedId, connected, loading, creating, onCreate }: Props) {
  const { setOpenMobile } = useSidebar()
  return <Sidebar>
    <SidebarHeader className="chat-sidebar-header gap-6 p-4">
      <div className="sidebar-brand flex items-center gap-2.5 px-1 py-1"><Avatar className="rounded-lg"><AvatarFallback className="rounded-lg bg-primary text-primary-foreground"><AudioLines className="size-4" /></AvatarFallback></Avatar><span className="text-base font-semibold tracking-tight">OutLoud</span></div>
      <Button variant="outline" size="lg" className="justify-start" onClick={() => { onCreate(); setOpenMobile(false) }} disabled={!connected || creating}><Plus />New chat</Button>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup className="px-3">
        <SidebarGroupLabel>Conversations</SidebarGroupLabel>
        <SidebarGroupContent><nav aria-label="Conversations"><SidebarMenu>
          {loading ? [0, 1, 2].map((item) => <SidebarMenuItem key={item}><SidebarMenuSkeleton /></SidebarMenuItem>) : list.map((item) => <SidebarMenuItem key={item.id}>
            <SidebarMenuButton className="h-auto min-h-9 py-2" isActive={selectedId === item.id} aria-label={`Select ${item.title}`} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => { library.select(item.id); setOpenMobile(false) }} title={item.title}><MessageSquare /><span>{item.title}</span></SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu></nav></SidebarGroupContent>
        {!loading && !list.length && <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">Your conversations will appear here.</p>}
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
}
