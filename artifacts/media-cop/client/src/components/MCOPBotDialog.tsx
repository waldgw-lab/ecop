import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";

interface MCOPBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When true (the Curated view), the bot is told it may also answer about the
   * curated "Top Stories". The SERVER still independently verifies curated
   * access before granting it — this flag is only a hint, never an authorization.
   */
  curatedContext?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function MCOPBotDialog({ open, onOpenChange, curatedContext }: MCOPBotDialogProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live tally across all 16 archive source tables. Server caches for 5 min.
  const { data: archiveCount } = useQuery<{ total: number }>({
    queryKey: ['/api/team/mcopBot/archive-count'],
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || loading) return;

    const userQuery = query.trim();
    setQuery("");
    setMessages(prev => [...prev, { role: 'user', content: userQuery }]);
    setLoading(true);

    try {
      const response = await apiRequest('POST', '/api/team/mcopBot', { query: userQuery, curatedContext: !!curatedContext });
      const data = await response.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[750px] max-h-[90vh] flex flex-col" data-testid="mcopBot-dialog">
        <DialogHeader className="pb-4 border-b">
          <DialogTitle className="flex items-center gap-3" data-testid="mcopBot-dialog-title">
            <img
              src={mcopBotIcon}
              alt="MCOP Bot"
              className="w-10 h-10 rounded-full ring-2 ring-primary/20"
              data-testid="mcopBot-dialog-icon"
            />
            <div className="flex flex-col">
              <span className="text-lg" data-testid="mcopBot-dialog-name">MCOP Bot</span>
              <span className="text-sm font-normal text-muted-foreground" data-testid="mcopBot-dialog-subtitle">Ask questions about recent news</span>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pr-3 py-4">
          <div className="space-y-5">
            {messages.length === 0 ? (
              <div className="text-center py-16" data-testid="mcopBot-welcome">
                <img
                  src={mcopBotIcon}
                  alt="MCOP Bot"
                  className="w-20 h-20 rounded-full mx-auto mb-5 ring-2 ring-primary/10"
                />
                <p className="text-base font-medium">Hi! I'm MCOP Bot.</p>
                <p className="text-sm text-muted-foreground mt-2">Ask me anything about recent news.</p>
                <p className="text-sm text-muted-foreground mt-1" data-testid="text-mcopBot-archive-count">
                  {archiveCount?.total
                    ? `I have access to over ${archiveCount.total.toLocaleString()} articles from the team archive.`
                    : 'I have access to the full team archive.'}
                </p>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  data-testid={`mcopBot-message-${msg.role}-${idx}`}
                >
                  {msg.role === 'assistant' && (
                    <img
                      src={mcopBotIcon}
                      alt="MCOP Bot"
                      className="w-7 h-7 rounded-full flex-shrink-0 mt-1"
                    />
                  )}
                  <div
                    className={`max-w-[85%] rounded-xl px-4 py-3 ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground text-base'
                        : 'bg-muted text-base'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-base dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 dark:text-blue-400 underline hover:opacity-80 break-all cursor-pointer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {children}
                              </a>
                            ),
                            p: ({ children }) => <p className="mb-3 last:mb-0 text-base leading-relaxed">{children}</p>,
                            ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1.5">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1.5">{children}</ol>,
                            li: ({ children }) => <li className="text-base leading-relaxed">{children}</li>,
                            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                            h1: ({ children }) => <h4 className="font-semibold text-base mb-2 mt-4 first:mt-0">{children}</h4>,
                            h2: ({ children }) => <h4 className="font-semibold text-base mb-2 mt-4 first:mt-0">{children}</h4>,
                            h3: ({ children }) => <h4 className="font-semibold text-base mb-1.5 mt-3 first:mt-0">{children}</h4>,
                            code: ({ children }) => (
                              <code className="bg-background/50 rounded px-1.5 py-0.5 text-sm font-mono">{children}</code>
                            ),
                            blockquote: ({ children }) => (
                              <blockquote className="border-l-2 border-primary/30 pl-4 italic text-muted-foreground my-3">{children}</blockquote>
                            ),
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                </div>
              ))
            )}
            {loading && (
              <div className="flex gap-3 justify-start" data-testid="mcopBot-loading">
                <img
                  src={mcopBotIcon}
                  alt="MCOP Bot"
                  className="w-7 h-7 rounded-full flex-shrink-0 mt-1"
                />
                <div className="bg-muted rounded-xl px-4 py-3 text-base flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span data-testid="mcopBot-loading-text">Thinking...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex gap-3 pt-4 border-t items-end"
        >
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (query.trim() && !loading) {
                  e.currentTarget.form?.requestSubmit();
                }
              }
            }}
            placeholder="Ask MCOP Bot a question..."
            disabled={loading}
            className="min-h-[80px] max-h-[150px] resize-none text-base"
            data-testid="input-mcopBot-query"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!query.trim() || loading}
            data-testid="button-mcopBot-send"
          >
            <Send className="w-5 h-5" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
