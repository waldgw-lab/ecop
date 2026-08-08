import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, List, ListOrdered, Link as LinkIcon, Image as ImageIcon, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCallback, useEffect } from 'react';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  onImageUpload?: (file: File) => Promise<string>;
  sendAdornment?: React.ReactNode;
}

function ToolbarButton({ 
  onClick, 
  isActive, 
  disabled, 
  children, 
  title 
}: { 
  onClick: () => void; 
  isActive?: boolean; 
  disabled?: boolean; 
  children: React.ReactNode; 
  title: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? "secondary" : "ghost"}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={`button-editor-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      {children}
    </Button>
  );
}

function MenuBar({ editor, onImageUpload, disabled }: { editor: Editor | null; onImageUpload?: (file: File) => Promise<string>; disabled?: boolean }) {
  const addLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Enter URL:');
    if (url) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  const handleImageClick = useCallback(() => {
    if (!editor) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file && onImageUpload) {
        try {
          const url = await onImageUpload(file);
          editor.chain().focus().setImage({ src: url }).run();
        } catch (error) {
          console.error('Failed to upload image:', error);
        }
      }
    };
    input.click();
  }, [editor, onImageUpload]);

  if (!editor) return null;

  return (
    <div className="flex items-center gap-0.5 p-1 border-b bg-muted/30">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
        disabled={disabled}
        title="Bold"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
        disabled={disabled}
        title="Italic"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <div className="w-px h-4 bg-border mx-1" />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        isActive={editor.isActive('bulletList')}
        disabled={disabled}
        title="Bullet List"
      >
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        isActive={editor.isActive('orderedList')}
        disabled={disabled}
        title="Numbered List"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <div className="w-px h-4 bg-border mx-1" />
      <ToolbarButton
        onClick={addLink}
        isActive={editor.isActive('link')}
        disabled={disabled}
        title="Add Link"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      {onImageUpload && (
        <ToolbarButton
          onClick={handleImageClick}
          disabled={disabled}
          title="Add Image"
        >
          <ImageIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
      )}
    </div>
  );
}

export function RichTextEditor({ 
  value, 
  onChange, 
  onSubmit, 
  placeholder = "Share a story or post...", 
  disabled = false,
  onImageUpload,
  sendAdornment,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        link: false,
      }),
      Image.configure({
        inline: true,
        allowBase64: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-primary underline',
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[60px] p-3',
      },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
          const files = Array.from(event.dataTransfer.files);
          const imageFiles = files.filter(file => file.type.startsWith('image/'));
          
          if (imageFiles.length > 0 && onImageUpload) {
            event.preventDefault();
            imageFiles.forEach(async (file) => {
              try {
                const url = await onImageUpload(file);
                const { schema } = view.state;
                const imageNode = schema.nodes.image?.create({ src: url });
                if (imageNode) {
                  const transaction = view.state.tr.replaceSelectionWith(imageNode);
                  view.dispatch(transaction);
                }
              } catch (error) {
                console.error('Failed to upload dropped image:', error);
              }
            });
            return true;
          }
        }
        return false;
      },
      handlePaste: (view, event) => {
        if (!onImageUpload) return false;
        
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        let imageFile: File | null = null;

        const items = clipboardData.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
              imageFile = item.getAsFile();
              if (imageFile) break;
            }
          }
        }

        if (!imageFile && clipboardData.files && clipboardData.files.length > 0) {
          for (let i = 0; i < clipboardData.files.length; i++) {
            if (clipboardData.files[i].type.startsWith('image/')) {
              imageFile = clipboardData.files[i];
              break;
            }
          }
        }

        if (imageFile) {
          event.preventDefault();
          const file = imageFile;
          onImageUpload(file).then(url => {
            const { schema } = view.state;
            const imageNode = schema.nodes.image?.create({ src: url });
            if (imageNode) {
              const transaction = view.state.tr.replaceSelectionWith(imageNode);
              view.dispatch(transaction);
            }
          }).catch(error => {
            console.error('Failed to upload pasted image:', error);
          });
          return true;
        }

        return false;
      },
    },
  });

  useEffect(() => {
    if (editor && value === '' && editor.getHTML() !== '<p></p>') {
      editor.commands.clearContent();
    }
  }, [value, editor]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const content = editor?.getHTML() || '';
      const hasContent = content !== '<p></p>' && content.trim() !== '';
      if (hasContent && !disabled) {
        e.preventDefault();
        onSubmit();
      }
    }
  }, [editor, onSubmit, disabled]);

  const hasContent = editor?.getHTML() !== '<p></p>' && editor?.getHTML().trim() !== '';

  return (
    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end w-full">
      <div 
        className="flex-1 min-w-0 border rounded-md overflow-hidden bg-background"
        onKeyDown={handleKeyDown}
      >
        <MenuBar editor={editor} onImageUpload={onImageUpload} disabled={disabled} />
        <EditorContent 
          editor={editor} 
          className="[&_.ProseMirror]:min-h-[60px] [&_.ProseMirror_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child]:before:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child]:before:float-left [&_.ProseMirror_p.is-editor-empty:first-child]:before:pointer-events-none [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded-md [&_.ProseMirror_img]:my-2"
          data-testid="editor-content"
        />
      </div>
      <div className="flex gap-2 items-center justify-end">
        {sendAdornment}
        <Button 
          type="button"
          size="icon"
          onClick={onSubmit}
          disabled={!hasContent || disabled}
          className="flex-1 sm:flex-none w-auto sm:w-9"
          data-testid="button-send-message"
        >
          <Send className="h-4 w-4" />
          <span className="sm:hidden ml-2">Send</span>
        </Button>
      </div>
    </div>
  );
}
