import { Button } from '@/components/ui/button'

const suggestions = [
  { label: 'Brainstorm ideas', prompt: 'Help me brainstorm ideas for a project.' },
  { label: 'Make a plan', prompt: 'Help me turn my ideas into a practical plan.' },
  { label: 'Write something', prompt: 'Help me write a clear first draft.' },
  { label: 'Explain a concept', prompt: 'Help me understand a concept, with a simple example.' },
]

export function ChatSuggestions({ enabled, onSelect }: { enabled: boolean; onSelect: (prompt: string) => void }) {
  return <div className="chat-suggestions">
    {suggestions.map(({ label, prompt }) => <Button key={label} variant="outline" size="sm" disabled={!enabled} onClick={() => onSelect(prompt)}>{label}</Button>)}
  </div>
}
