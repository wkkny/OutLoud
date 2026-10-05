import { useMemo, useState } from 'react'
import { AudioLines, MessageSquare, Plus, Search, SquarePen } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, useSidebar } from '@/components/ui/sidebar'
import type { Conversation, ConversationLibrary } from '@/lib/conversations'
import type { StudySubject } from '@/lib/study'

type Props = {
  library: ConversationLibrary; list: Conversation[]; selectedId: string | null; subjects: StudySubject[];
  connected: boolean; loading: boolean; creating: boolean; onCreate: (subjectId: string | null, subject?: StudySubject) => void;
  onStudy: () => void; onChat: () => void; onMode: (mode: 'study' | 'chat') => void;
}

export function AppSidebar({ library, list, selectedId, subjects, connected, loading, creating, onCreate, onStudy, onChat, onMode }: Props) {
  const { setOpenMobile } = useSidebar()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const selected = list.find(item => item.id === selectedId)
  const visible = useMemo(() => list.filter(item => (filter === 'all' || item.subject_id === filter) && `${item.title} ${filter === 'all' ? subjects.find(subject => subject.id === item.subject_id)?.name ?? 'Unassigned' : ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [list, filter, search, subjects])
  const activeSubject = filter === 'all' ? null : subjects.find(subject => subject.id === filter) ?? null
  const openStudyDashboard = () => { onStudy(); setOpenMobile(false) }
  const subjectOptions = [{ label: 'All subjects', value: 'all' }, ...subjects.map(subject => ({ label: subject.name, value: subject.id }))]
  const selectConversation = (item: Conversation) => { onChat(); library.select(item.id); setOpenMobile(false) }
  const create = () => { onChat(); onCreate(activeSubject?.id ?? null, activeSubject ?? undefined); setOpenMobile(false) }
  return <Sidebar>
    <SidebarHeader className="chat-sidebar-header gap-0 px-4 py-3">
      <div className="sidebar-brand flex items-center gap-2.5 px-1 py-1"><Avatar className="rounded-lg"><AvatarFallback className="rounded-lg bg-primary text-primary-foreground"><AudioLines className="size-4" /></AvatarFallback></Avatar><span className="text-base font-semibold tracking-tight">OutLoud</span></div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup className="px-3">
        <SidebarGroupContent>
          <div className="sidebar-conversation-tools">
            <div className="sidebar-search-row"><label className="sidebar-search"><Search className="size-4" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search" aria-label="Search conversations" /></label><Button variant="ghost" size="icon-sm" aria-label="New chat" title="New chat" onClick={create} disabled={!connected || creating}><SquarePen /></Button></div>
            <label className="sr-only" htmlFor="conversation-subject-filter">Filter conversations by subject</label>
            <Select items={subjectOptions} value={filter} onValueChange={value => setFilter(typeof value === 'string' ? value : 'all')}>
              <SelectTrigger id="conversation-subject-filter" className="sidebar-subject-select"><SelectValue /></SelectTrigger>
              <SelectContent align="start"><SelectGroup>{subjectOptions.map(subject => <SelectItem key={subject.value} value={subject.value}>{subject.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>
          <nav aria-label="Conversations"><SidebarMenu>
            {loading ? [0, 1, 2].map(item => <SidebarMenuItem key={item}><SidebarMenuSkeleton /></SidebarMenuItem>) : visible.map(item => <SidebarMenuItem key={item.id}>
              <SidebarMenuButton className="h-auto min-h-9 py-2" isActive={selectedId === item.id} aria-label={`Select ${item.title}`} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => selectConversation(item)} title={item.title}>
                <MessageSquare /><span className="sidebar-conversation-name">{filter === 'all' && <small>{subjects.find(subject => subject.id === item.subject_id)?.name ?? 'Unassigned'}</small>}{item.title}</span>
              </SidebarMenuButton>
              <label className="sr-only" htmlFor={`move-${item.id}`}>Move {item.title} to subject</label>
              <select id={`move-${item.id}`} className="sidebar-move-select" aria-label={`Move ${item.title} to subject`} value={item.subject_id ?? ''} onClick={event => event.stopPropagation()} onChange={event => { void library.updateWorkspace(item.id, { subject_id: event.target.value || null }) }}>
                <option value="">Unassigned</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </select>
            </SidebarMenuItem>)}
          </SidebarMenu></nav>
        </SidebarGroupContent>
        {!loading && !visible.length && <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">{search ? 'No matching conversations.' : list.length ? 'No conversations for this subject.' : 'Your conversations will appear here.'}</p>}
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="chat-sidebar-footer">
      <div className="sidebar-mode-switch" role="group" aria-label="Conversation mode">
        {(['study', 'chat'] as const).map(mode => <Button key={mode} variant={selected?.mode === mode ? 'secondary' : 'ghost'} aria-pressed={selected?.mode === mode} disabled={!selected || !connected} onClick={() => onMode(mode)}>{mode === 'study' ? 'Study' : 'Chat'}</Button>)}
      </div>
      <div className="sidebar-footer-actions"><Button variant="ghost" size="sm" className="justify-start" onClick={openStudyDashboard}>Study dashboard</Button><Button variant="ghost" size="icon-sm" aria-label="New subject" title="New subject" onClick={openStudyDashboard}><Plus /></Button></div>
    </SidebarFooter>
  </Sidebar>
}
