import { useRef, useState, type ReactNode } from 'react'
import { useToastManager } from '@/components/ui/toast'
import { Pencil, Trash2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useSidebar } from '@/components/ui/sidebar'
import type { Conversation, ConversationLibrary } from '@/lib/conversations'

export function ConversationActions({ conversation, library, enabled, children }: {
  conversation: Conversation; library: ConversationLibrary; enabled: boolean; children: ReactNode
}) {
  const { triggerRef } = useSidebar()
  const rowRef = useRef<HTMLDivElement>(null)
  const { add } = useToastManager()
  const [title, setTitle] = useState(conversation.title)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const restoreFocus = (event: Event) => {
    event.preventDefault()
    const row = rowRef.current?.querySelector('button')
    if (row?.isConnected) row.focus()
    else triggerRef.current?.focus()
  }

  const rename = async () => {
    setPending(true)
    setError(null)
    try {
      const result = await library.rename(conversation.id, title)
      if (!result.ok) setError(result.error)
      else {
        setRenameOpen(false)
        add({ title: 'Conversation renamed', description: title.trim(), type: 'success' })
      }
    } finally { setPending(false) }
  }
  const remove = async () => {
    setPending(true)
    setError(null)
    try {
      const result = await library.delete(conversation.id)
      if (!result.ok) setError(result.error)
      else {
        setDeleteOpen(false)
        add({ title: 'Conversation deleted', description: conversation.title, type: 'success' })
      }
    } finally { setPending(false) }
  }

  return <>
    <ContextMenu>
      <ContextMenuTrigger ref={rowRef}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!enabled} onClick={() => setRenameOpen(true)}><Pencil className="size-4" /> Rename</ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={!enabled} onClick={() => setDeleteOpen(true)}><Trash2 className="size-4" /> Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <Dialog open={renameOpen} onOpenChange={(open) => {
      if (pending) return
      setRenameOpen(open)
      setTitle(conversation.title)
      setError(null)
    }}>
      <DialogContent showCloseButton={!pending} onCloseAutoFocus={restoreFocus}>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (enabled && title.trim() && !pending) void rename() }}>
          <DialogHeader><DialogTitle>Rename conversation</DialogTitle><DialogDescription>Give this conversation a name you can find later.</DialogDescription></DialogHeader>
          <div className="grid gap-2"><Label htmlFor="conversation-title">Conversation title</Label><Input id="conversation-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} disabled={pending} /></div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter><DialogClose asChild><Button type="button" variant="outline" disabled={pending}>Cancel</Button></DialogClose><Button type="submit" disabled={!enabled || !title.trim() || pending}>{pending ? 'Saving…' : 'Save name'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!pending) { setDeleteOpen(open); setError(null) } }}>
      <AlertDialogContent onCloseAutoFocus={restoreFocus}>
        <AlertDialogHeader><AlertDialogTitle>Delete conversation?</AlertDialogTitle><AlertDialogDescription>Delete “{conversation.title}” and its saved content? This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>Keep conversation</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={!enabled || pending} onClick={(event) => { event.preventDefault(); void remove() }}>{pending ? 'Deleting…' : 'Confirm delete'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
