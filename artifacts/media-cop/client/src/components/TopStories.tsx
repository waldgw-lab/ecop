import { Card } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export interface TopStoryProps {
  id: string;
  title: string;
  url: string;
  category: string;
  source: string;
  summary: string;
  importance: 'critical' | 'high' | 'medium';
  timestamp: string;
}

interface TopStoriesProps {
  stories: TopStoryProps[];
}

export default function TopStories({ stories }: TopStoriesProps) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="h-5 w-5 text-destructive" data-testid="icon-top-stories" />
        <h2 className="text-lg font-bold" data-testid="text-top-stories-title">
          Top Stories
        </h2>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {stories.map((story, index) => (
          <Card
            key={story.id}
            className="p-3 border-l-4 border-l-destructive hover-elevate active-elevate-2 transition-shadow cursor-pointer"
            data-testid={`card-top-story-${story.id}`}
            onClick={() => {
              window.open(story.url, '_blank');
              console.log('Top story clicked:', story.title);
            }}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center font-bold text-sm">
                {index + 1}
              </div>
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs text-muted-foreground font-mono" data-testid={`text-source-${story.id}`}>
                    {story.source}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono" data-testid={`text-timestamp-${story.id}`}>
                    • {story.timestamp}
                  </span>
                </div>
                
                <h3 className="text-base font-bold leading-snug" data-testid={`text-title-${story.id}`}>
                  {story.title}
                </h3>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
