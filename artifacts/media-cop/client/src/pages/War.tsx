import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { Shield, ExternalLink, ChevronLeft, ChevronRight, MapPin, AlertTriangle, Filter, Search, Send, Loader2, Newspaper, Play } from "lucide-react";
import { Link } from "wouter";
import ThemeToggle from "@/components/ThemeToggle";
import TopicFilterDialog from "@/components/TopicFilterDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";
import { cleanTruthContent } from "@/lib/cleanTruthContent";
import type { Headline, TruthSocialPost, XPost, FirstAlert, RapidResponsePost, DOWResponsePost, SentDefenderPost, WarScreenshot } from "@shared/schema";
import { INFLUENCER_X_ACCOUNTS } from "@shared/influencerXAccounts";

interface StreamHeadline extends Headline {
  imageUrl?: string | null;
}

type EnhancedTruthSocialPost = TruthSocialPost;

type EnhancedXPost = XPost & { videoUrl?: string | null };

interface StreamData {
  topStories: StreamHeadline[];
  truthSocialPosts: EnhancedTruthSocialPost[];
  xPosts: EnhancedXPost[];
  firstAlerts: FirstAlert[];
  feedFromMcop?: boolean;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getSourceLogo(source: string): string | null {
  const logoMap: Record<string, string> = {
    'CNN': 'https://upload.wikimedia.org/wikipedia/commons/b/b1/CNN.svg',
    'Fox News': 'https://upload.wikimedia.org/wikipedia/commons/6/67/Fox_News_Channel_logo.svg',
    'Reuters': 'https://upload.wikimedia.org/wikipedia/commons/8/8d/Reuters_Logo.svg',
    'AP': 'https://upload.wikimedia.org/wikipedia/commons/0/0c/Associated_Press_logo_2012.svg',
    'BBC': 'https://upload.wikimedia.org/wikipedia/commons/4/41/BBC_Logo_2021.svg',
  };
  return logoMap[source] || null;
}

function getOutletLogoUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    if (hostname.includes('archive.is') || hostname.includes('archive.ph') || hostname.includes('archive.org')) {
      return null;
    }
    return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${hostname}&size=128`;
  } catch {
    return null;
  }
}

function StoryCard({ story, isVisible }: { story: StreamHeadline; isVisible: boolean }) {
  const isVideo = story.imageUrl?.startsWith('VIDEO:');
  const mediaUrl = isVideo ? story.imageUrl?.replace('VIDEO:', '') : story.imageUrl;
  const isLogoFallback = mediaUrl?.includes('logo.clearbit.com') || mediaUrl?.includes('gstatic.com/faviconV2');
  
  return (
    <a
      href={story.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group relative rounded-xl overflow-hidden bg-slate-800/50 hover:bg-slate-700/50 transition-all [transition-duration:3000ms] flex flex-col ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      data-testid={`war-story-${story.id}`}
    >
      <div className="relative h-44 overflow-hidden">
        {isVideo && mediaUrl ? (
          <video 
            src={mediaUrl}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLVideoElement).style.display = 'none';
            }}
          />
        ) : mediaUrl && !isLogoFallback ? (
          <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-800 relative">
            <img 
              src={mediaUrl} 
              alt="" 
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                const logoUrl = getOutletLogoUrl(story.url);
                if (logoUrl && !img.dataset.triedLogo) {
                  img.dataset.triedLogo = 'true';
                  img.style.objectFit = 'contain';
                  img.style.width = '5rem';
                  img.style.height = '5rem';
                  img.style.position = 'absolute';
                  img.style.top = '50%';
                  img.style.left = '50%';
                  img.style.transform = 'translate(-50%, -50%)';
                  img.style.opacity = '0.7';
                  img.src = logoUrl;
                } else {
                  img.style.display = 'none';
                }
              }}
            />
          </div>
        ) : isLogoFallback && mediaUrl ? (
          <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-800 flex flex-col items-center justify-center gap-2">
            <img 
              src={mediaUrl} 
              alt={story.source || ''} 
              className="w-16 h-16 object-contain"
              style={{ imageRendering: 'auto' }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            {story.source && (
              <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">{story.source}</span>
            )}
          </div>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center">
            <Shield className="w-10 h-10 text-slate-600" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        {story.source && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white uppercase">
            {story.source}
          </div>
        )}
      </div>
      
      <div className="p-3 flex flex-col">
        <h3 className="text-base font-bold text-white leading-snug group-hover:text-blue-400 transition-colors">
          {story.title}
        </h3>
        
        {story.summaryBullets && story.summaryBullets.length > 0 && (
          <ul className="mt-2 space-y-1">
            {story.summaryBullets.slice(0, 3).map((bullet, idx) => (
              <li key={idx} className="text-sm text-slate-300 flex items-start gap-1.5">
                <span className="text-blue-400 mt-0.5">•</span>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </a>
  );
}

function TopStoriesCarousel({ stories }: { stories: StreamHeadline[] }) {
  const [slotStates, setSlotStates] = useState<{storyIndex: number; phase: string}[]>([
    { storyIndex: 0, phase: 'visible' },
    { storyIndex: 1, phase: 'visible' },
    { storyIndex: 2, phase: 'visible' },
    { storyIndex: 3, phase: 'visible' },
  ]);
  const [nextSlotToUpdate, setNextSlotToUpdate] = useState(0);
  
  const limitedStories = useMemo(() => stories.slice(0, 8), [stories]);
  const totalStories = limitedStories.length;
  
  useEffect(() => {
    if (totalStories <= 4) return;
    
    const interval = setInterval(() => {
      const slotToUpdate = nextSlotToUpdate;
      
      setSlotStates(prev => {
        const newStates = [...prev];
        newStates[slotToUpdate] = { ...newStates[slotToUpdate], phase: 'darkening' };
        return newStates;
      });
      
      setTimeout(() => {
        const currentIndices = slotStates.map(s => s.storyIndex);
        let nextStoryIndex = (Math.max(...currentIndices) + 1) % totalStories;
        while (currentIndices.includes(nextStoryIndex)) {
          nextStoryIndex = (nextStoryIndex + 1) % totalStories;
        }
        
        setSlotStates(prev => {
          const newStates = [...prev];
          newStates[slotToUpdate] = { storyIndex: nextStoryIndex, phase: 'dark' };
          return newStates;
        });
        
        setTimeout(() => {
          setSlotStates(prev => {
            const newStates = [...prev];
            newStates[slotToUpdate] = { ...newStates[slotToUpdate], phase: 'brightening' };
            return newStates;
          });
          
          setTimeout(() => {
            setSlotStates(prev => {
              const newStates = [...prev];
              newStates[slotToUpdate] = { ...newStates[slotToUpdate], phase: 'visible' };
              return newStates;
            });
          }, 2000);
        }, 50);
      }, 3000);
      
      setNextSlotToUpdate(prev => (prev + 1) % 4);
    }, 15000);
    
    return () => clearInterval(interval);
  }, [totalStories, nextSlotToUpdate, slotStates]);
  
  const handlePrev = () => {
    setSlotStates(prev => prev.map(slot => ({
      storyIndex: (slot.storyIndex - 1 + totalStories) % totalStories,
      phase: 'visible',
    })));
  };
  
  const handleNext = () => {
    setSlotStates(prev => prev.map(slot => ({
      storyIndex: (slot.storyIndex + 1) % totalStories,
      phase: 'visible',
    })));
  };
  
  const getBrightnessStyle = (phase: string) => {
    switch (phase) {
      case 'darkening':
        return { filter: 'brightness(0)', transition: 'filter 3s ease-in-out' };
      case 'dark':
        return { filter: 'brightness(0)', transition: 'none' };
      case 'brightening':
        return { filter: 'brightness(1)', transition: 'filter 2s ease-in-out' };
      default:
        return { filter: 'brightness(1)', transition: 'filter 2s ease-in-out' };
    }
  };
  
  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-2">
        {slotStates.map((slot, slotIndex) => {
          const story = limitedStories[slot.storyIndex];
          if (!story) return null;
          
          return (
            <div 
              key={slotIndex} 
              className="relative"
              style={getBrightnessStyle(slot.phase)}
            >
              <StoryCard 
                story={story} 
                isVisible={true}
              />
            </div>
          );
        })}
      </div>
      
      {totalStories > 4 && (
        <>
          <button
            onClick={handlePrev}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 bg-slate-700/80 hover:bg-slate-600 rounded-full p-1.5 text-white shadow-lg transition-colors"
            data-testid="carousel-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={handleNext}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 bg-slate-700/80 hover:bg-slate-600 rounded-full p-1.5 text-white shadow-lg transition-colors"
            data-testid="carousel-next"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </>
      )}
      
      <div className="absolute bottom-1 right-2 text-[10px] text-slate-500">
        {Math.min(stories.length, 8)} Stories in Rotation
      </div>
    </div>
  );
}

function extractMediaUrl(content: string): string | null {
  const imagePatterns = [
    /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)/gi,
    /https?:\/\/pbs\.twimg\.com\/[^\s]+/gi,
    /https?:\/\/media\.[^\s]+\.(?:jpg|jpeg|png|gif|webp)/gi,
  ];
  
  for (const pattern of imagePatterns) {
    const match = content.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function WarPostVideo({ videoUrl, thumbnailUrl, truthSocialUrl, postId }: { videoUrl: string; thumbnailUrl?: string | null; truthSocialUrl: string; postId: string }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  if (videoFailed) {
    if (thumbnailUrl && !thumbFailed) {
      return (
        <div
          className="mt-2 rounded-lg overflow-hidden relative cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(truthSocialUrl, '_blank');
          }}
        >
          <img
            src={thumbnailUrl}
            alt="Video thumbnail"
            className="w-full h-auto max-h-48 object-contain bg-black/20"
            onError={() => setThumbFailed(true)}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center">
              <Play className="w-5 h-5 text-white fill-white ml-0.5" />
            </div>
          </div>
          <div className="absolute bottom-1 left-1 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded">
            Watch on Truth Social
          </div>
        </div>
      );
    }
    return (
      <div
        className="mt-2 rounded-lg bg-slate-700/50 p-2 flex items-center gap-2 cursor-pointer"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(truthSocialUrl, '_blank');
        }}
      >
        <Play className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[10px] text-slate-400">Video - tap to watch on Truth Social</span>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg overflow-hidden">
      <video
        src={videoUrl}
        controls
        preload="metadata"
        poster={thumbnailUrl || undefined}
        className="w-full h-auto max-h-48 bg-black/20"
        onError={() => setVideoFailed(true)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
    </div>
  );
}

function TruthSocialCard({ post }: { post: EnhancedTruthSocialPost }) {
  const [imgFailed, setImgFailed] = useState(false);
  // Match Truth Social's own behavior: show post.imageUrl when set, otherwise
  // nothing. Do NOT scan post.content for embedded URLs — that pulls Trump's
  // profile/header image out of the post HTML and attaches it as a fake
  // attachment on text-only posts.
  const mediaUrl = post.imageUrl;
  const cleanContent = cleanTruthContent(post.content).replace(/https?:\/\/[^\s]+/g, '').trim();
  const showContent = cleanContent && cleanContent !== '[Media attachment]';
  
  return (
    <a
      href={post.truthSocialUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 transition-colors border border-slate-700/50"
      data-testid={`war-truth-${post.id}`}
    >
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-red-500 to-blue-600 flex items-center justify-center text-white font-bold text-xs">
            P
          </div>
          <div>
            <div className="text-xs font-bold text-white">POTUS</div>
            <div className="text-[10px] text-slate-400">
              {post.isReblog && post.rebloggedFrom ? (
                <span className="text-amber-400">ReTruth @{post.rebloggedFrom}</span>
              ) : (
                '@realDonaldTrump'
              )}
            </div>
          </div>
          <div className="ml-auto text-[10px] text-slate-500 flex items-center gap-1">
            <span className="text-red-400 font-bold">Truth.</span>
            {formatTimeAgo(new Date(post.postedAt))}
          </div>
        </div>
        {showContent && (
          <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
            {cleanContent}
          </p>
        )}
        {post.videoUrl && (
          <WarPostVideo
            videoUrl={post.videoUrl}
            thumbnailUrl={post.videoThumbnailUrl}
            truthSocialUrl={post.truthSocialUrl}
            postId={post.id}
          />
        )}
        {mediaUrl && !post.videoUrl && !imgFailed && (
          <div className="mt-2 rounded-lg overflow-hidden">
            <img 
              src={mediaUrl} 
              alt="Post attachment" 
              className="w-full h-auto max-h-48 object-contain bg-black/20"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          </div>
        )}
      </div>
    </a>
  );
}

function XPostCard({ post }: { post: EnhancedXPost }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const mediaUrl = post.imageUrl || extractMediaUrl(post.content);
  const cleanContent = post.content.replace(/https?:\/\/[^\s]+/g, '').trim();
  
  const getAccountStyle = (account: string) => {
    switch (account) {
      case 'SecWar':
        return { initial: 'S', name: '@SecWar', gradient: 'from-blue-500 to-purple-600' };
      case 'DOWResponse':
        return { initial: 'D', name: '@DOWResponse', gradient: 'from-green-500 to-teal-600' };
      case 'Rapidresponse47':
        return { initial: 'R', name: '@Rapidresponse47', gradient: 'from-red-500 to-orange-600' };
      case 'sentdefender':
        return { initial: 'S', name: '@sentdefender', gradient: 'from-indigo-500 to-violet-600' };
      case 'PeteHegseth':
        return { initial: 'P', name: '@PeteHegseth', gradient: 'from-amber-500 to-yellow-600' };
      case 'other':
        return { initial: 'O', name: 'Other', gradient: 'from-cyan-500 to-teal-600' };
      default:
        return { initial: account.charAt(0).toUpperCase(), name: `@${account}`, gradient: 'from-gray-500 to-slate-600' };
    }
  };
  
  const accountStyle = getAccountStyle(post.sourceAccount);
  
  const isScreenshot = post.sourceAccount === 'other';
  const hasLink = post.xUrl && post.xUrl !== '#';
  const Wrapper = (isScreenshot && !hasLink) ? 'div' : 'a';
  const wrapperProps = (isScreenshot && !hasLink) ? {} : { href: post.xUrl, target: '_blank', rel: 'noopener noreferrer' };

  if (isScreenshot) {
    return (
      <Wrapper
        {...wrapperProps as any}
        className="block rounded-xl overflow-hidden hover:opacity-90 transition-opacity"
        data-testid={`war-x-${post.id}`}
      >
        {mediaUrl && (
          <img src={mediaUrl} alt="" className="w-full h-auto" />
        )}
      </Wrapper>
    );
  }

  return (
    <Wrapper
      {...wrapperProps as any}
      className="block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 transition-colors border border-slate-700/50"
      data-testid={`war-x-${post.id}`}
    >
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${accountStyle.gradient} flex items-center justify-center text-white font-bold text-xs`}>
            {accountStyle.initial}
          </div>
          <div>
            <div className="text-xs font-bold text-white">{accountStyle.name}</div>
            <div className="text-[10px] text-slate-400">
              {post.isRetweet && post.retweetedFrom && `RT @${post.retweetedFrom}`}
            </div>
          </div>
          <div className="ml-auto text-[10px] text-slate-500 flex items-center gap-1">
            <span className="font-bold">X</span>
            {formatTimeAgo(new Date(post.postedAt))}
          </div>
        </div>
        <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
          {cleanContent || post.content}
        </p>
        {post.videoUrl && post.videoUrl.startsWith('http') && !post.videoUrl.includes('x.com/') && !videoFailed ? (
          <div className="mt-2 rounded-lg overflow-hidden">
            <video
              data-testid={`video-player-${post.postId}`}
              src={post.videoUrl}
              controls
              preload="metadata"
              poster={mediaUrl || undefined}
              className="w-full h-auto max-h-48 bg-black/20"
              onError={() => setVideoFailed(true)}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            />
          </div>
        ) : post.videoUrl ? (
          <div
            data-testid={`link-watch-video-${post.postId}`}
            className="mt-2 rounded-lg overflow-hidden relative cursor-pointer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(post.videoUrl!.includes('x.com/') ? post.videoUrl! : post.xUrl, '_blank');
            }}
          >
            {mediaUrl ? (
              <>
                <img 
                  src={mediaUrl} 
                  alt="Video thumbnail" 
                  className="w-full h-auto max-h-48 object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center">
                    <Play className="w-5 h-5 text-white fill-white ml-0.5" />
                  </div>
                </div>
                <div className="absolute bottom-1 left-1 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded">
                  Watch on X
                </div>
              </>
            ) : (
              <div className="bg-slate-700/50 p-2 flex items-center gap-2">
                <Play className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[10px] text-slate-400">Video - tap to watch on X</span>
              </div>
            )}
          </div>
        ) : mediaUrl ? (
          <div className="mt-2 rounded-lg overflow-hidden">
            <img 
              src={mediaUrl} 
              alt="" 
              className="w-full h-auto max-h-48 object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        ) : null}
      </div>
    </Wrapper>
  );
}

function FirstAlertCard({ alert }: { alert: FirstAlert }) {
  const isUrgent = alert.alertType === 'Urgent' || alert.alertType === 'Flash';
  
  return (
    <a
      href={alert.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`block rounded-xl p-3 transition-colors border ${
        isUrgent 
          ? 'bg-red-900/30 border-red-700/50 hover:bg-red-800/30' 
          : 'bg-slate-800/50 border-slate-700/50 hover:bg-slate-700/50'
      }`}
      data-testid={`war-alert-${alert.id}`}
    >
      <div className="flex items-start gap-2 mb-2">
        {isUrgent && <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />}
        <div className="flex-1">
          <p className="text-xs text-slate-200 font-medium leading-tight line-clamp-3">
            {alert.headline}
          </p>
        </div>
      </div>
      {alert.location && (
        <div className="flex items-center gap-1 text-[10px] text-slate-400 mt-1">
          <MapPin className="w-3 h-3" />
          <span className="line-clamp-1">{alert.location}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mt-2 text-[10px] text-slate-500">
        {alert.alertLists && alert.alertLists.length > 0 && (
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">
            {alert.alertLists[0]}
          </span>
        )}
        <span className="ml-auto">{formatTimeAgo(new Date(alert.publishedAt))}</span>
      </div>
    </a>
  );
}

const X_ACCOUNTS = [
  { id: 'SecWar', label: '@SecWar' },
  { id: 'PeteHegseth', label: '@PeteHegseth' },
  { id: 'sentdefender', label: '@sentdefender' },
  { id: 'DOWResponse', label: '@DOWResponse' },
  { id: 'Rapidresponse47', label: '@Rapidresponse47' },
  { id: 'other', label: 'Other' },
];

export default function War() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    fetch("/api/war/viewer/status", { credentials: "include" })
      .then(r => r.json())
      .then(data => setIsAuthenticated(data.authenticated))
      .catch(() => setIsAuthenticated(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    try {
      const response = await apiRequest("POST", "/api/war/viewer/auth", { password });
      if (response.ok) {
        setIsAuthenticated(true);
      } else {
        setAuthError("Invalid password");
      }
    } catch {
      setAuthError("Invalid password");
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Card className="w-full max-w-sm bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Shield className="w-5 h-5 text-amber-500" />
              War Dashboard
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label className="text-slate-300">Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="bg-slate-700 border-slate-600 text-white"
                  data-testid="input-war-viewer-password"
                  autoFocus
                />
                {authError && (
                  <p className="text-red-400 text-xs mt-1" data-testid="text-war-viewer-error">{authError}</p>
                )}
              </div>
              <Button type="submit" className="w-full" data-testid="button-war-viewer-login">
                Login
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <WarDashboard />;
}

function WarDashboard() {
  // For these feed queries, treat a 401 as "no data" instead of throwing
  // and keeping the previous cached value forever. Otherwise a transient
  // auth blip leaves the column stuck on stale data (e.g. 16-hour-old
  // posts) until the page is hard-reloaded.
  const feedQueryFn = useMemo(() => getQueryFn<unknown>({ on401: "returnNull" }), []);

  const { data: streamData, isLoading: isStreamLoading } = useQuery<StreamData>({
    queryKey: ['/api/war/feed'],
    refetchInterval: 60000,
  });
  
  const { data: xPostsData } = useQuery<XPost[] | null>({
    queryKey: ['/api/x-posts'],
    queryFn: feedQueryFn as any,
    refetchInterval: 60000,
  });
  
  const { data: influencerXPostsData } = useQuery<XPost[] | null>({
    queryKey: ['/api/influencer-x-posts'],
    queryFn: feedQueryFn as any,
    refetchInterval: 60000,
  });
  
  const { data: rapidResponseData } = useQuery<RapidResponsePost[] | null>({
    queryKey: ['/api/rapidresponse-posts'],
    queryFn: feedQueryFn as any,
    refetchInterval: 60000,
  });
  
  const { data: dowResponseData } = useQuery<DOWResponsePost[] | null>({
    queryKey: ['/api/dowresponse-posts'],
    queryFn: feedQueryFn as any,
    refetchInterval: 60000,
  });
  
  const { data: sentDefenderData } = useQuery<SentDefenderPost[] | null>({
    queryKey: ['/api/sentdefender-posts'],
    queryFn: feedQueryFn as any,
    refetchInterval: 60000,
  });

  const { data: warScreenshots = [] } = useQuery<WarScreenshot[]>({
    queryKey: ['/api/war/screenshots'],
    refetchInterval: 60000,
  });
  
  const [showTopStories, setShowTopStories] = useState(() => {
    const saved = localStorage.getItem('warShowTopStories');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showTruthSocial, setShowTruthSocial] = useState(() => {
    const saved = localStorage.getItem('warShowTruthSocial');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showXFeeds, setShowXFeeds] = useState(() => {
    const saved = localStorage.getItem('warShowXFeeds');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showFirstAlert, setShowFirstAlert] = useState(() => {
    const saved = localStorage.getItem('warShowFirstAlert');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [showInfluencerXPosts, setShowInfluencerXPosts] = useState(() => {
    const saved = localStorage.getItem('warShowInfluencerXPosts');
    return saved !== null ? JSON.parse(saved) : true;
  });
  
  useEffect(() => {
    localStorage.setItem('warShowTopStories', JSON.stringify(showTopStories));
  }, [showTopStories]);
  useEffect(() => {
    localStorage.setItem('warShowTruthSocial', JSON.stringify(showTruthSocial));
  }, [showTruthSocial]);
  useEffect(() => {
    localStorage.setItem('warShowXFeeds', JSON.stringify(showXFeeds));
  }, [showXFeeds]);
  useEffect(() => {
    localStorage.setItem('warShowFirstAlert', JSON.stringify(showFirstAlert));
  }, [showFirstAlert]);
  useEffect(() => {
    localStorage.setItem('warShowInfluencerXPosts', JSON.stringify(showInfluencerXPosts));
  }, [showInfluencerXPosts]);
  
  const [selectedXAccounts, setSelectedXAccounts] = useState<Set<string>>(() => {
    const validIds = new Set(X_ACCOUNTS.map(a => a.id));
    const saved = localStorage.getItem('warXAccountFilter');
    if (saved) {
      try {
        const parsed: string[] = JSON.parse(saved);
        const intersected = parsed.filter(id => validIds.has(id));
        if (intersected.length === 0) {
          return new Set(validIds);
        }
        return new Set(intersected);
      } catch {
        return new Set(validIds);
      }
    }
    return new Set(validIds);
  });
  const [xFilterOpen, setXFilterOpen] = useState(false);
  
  useEffect(() => {
    localStorage.setItem('warXAccountFilter', JSON.stringify(Array.from(selectedXAccounts)));
  }, [selectedXAccounts]);
  
  const [selectedInfluencerXAccounts, setSelectedInfluencerXAccounts] = useState<Set<string>>(() => {
    const validIds = new Set(INFLUENCER_X_ACCOUNTS.map(a => a.id));
    const saved = localStorage.getItem('warInfluencerXAccountFilter');
    if (saved) {
      try {
        const parsed: string[] = JSON.parse(saved);
        const intersected = parsed.filter(id => validIds.has(id));
        if (intersected.length === 0) {
          return new Set(validIds);
        }
        return new Set(intersected);
      } catch {
        return new Set(validIds);
      }
    }
    return new Set(validIds);
  });
  const [influencerXFilterOpen, setInfluencerXFilterOpen] = useState(false);
  
  useEffect(() => {
    localStorage.setItem('warInfluencerXAccountFilter', JSON.stringify(Array.from(selectedInfluencerXAccounts)));
  }, [selectedInfluencerXAccounts]);
  
  const [mcopBotOpen, setMcopBotOpen] = useState(false);
  
  const [headerSearchQuery, setHeaderSearchQuery] = useState('');
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  
  const [listFilterOpen, setListFilterOpen] = useState(false);
  const [selectedAlertLists, setSelectedAlertLists] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('warSelectedAlertLists');
      return saved !== null ? JSON.parse(saved) : [];
    } catch (error) {
      console.error('Failed to parse selected alert lists from localStorage:', error);
      return [];
    }
  });
  
  useEffect(() => {
    localStorage.setItem('warSelectedAlertLists', JSON.stringify(selectedAlertLists));
  }, [selectedAlertLists]);
  
  const toggleXAccount = (accountId: string) => {
    setSelectedXAccounts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(accountId)) {
        newSet.delete(accountId);
      } else {
        newSet.add(accountId);
      }
      return newSet;
    });
  };
  
  const toggleInfluencerXAccount = (accountId: string) => {
    setSelectedInfluencerXAccounts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(accountId)) {
        newSet.delete(accountId);
      } else {
        newSet.add(accountId);
      }
      return newSet;
    });
  };
  
  const topStories = streamData?.topStories || [];
  const truthSocialPosts = streamData?.truthSocialPosts || [];
  const firstAlerts = streamData?.firstAlerts || [];
  
  const availableAlertLists = useMemo(() => {
    const predefinedLists = [
      "Global Terrorism and Mass Violence",
      "Israel/Hamas",
      "China",
      "Five Eyes + NATO",
      "Russia/Ukraine",
      "US Politics and Military Affairs",
      "Worldwide Flash"
    ];
    
    const listsMap = new Map<string, number>();
    firstAlerts.forEach(alert => {
      if (alert.alertLists && Array.isArray(alert.alertLists)) {
        alert.alertLists.forEach(list => {
          listsMap.set(list, (listsMap.get(list) || 0) + 1);
        });
      }
    });
    
    return predefinedLists.map(name => ({ name, count: listsMap.get(name) || 0 }));
  }, [firstAlerts]);
  
  const filteredFirstAlerts = useMemo(() => {
    let filtered = firstAlerts;
    
    if (selectedAlertLists.length > 0) {
      filtered = firstAlerts.filter(alert => {
        if (!alert.alertLists || alert.alertLists.length === 0) {
          return false;
        }
        return alert.alertLists.some(list => selectedAlertLists.includes(list));
      });
    }
    
    return filtered.sort((a, b) => {
      const aIsFlash = a.alertType === 'Flash';
      const bIsFlash = b.alertType === 'Flash';
      
      if (aIsFlash && !bIsFlash) return -1;
      if (!aIsFlash && bIsFlash) return 1;
      
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
  }, [firstAlerts, selectedAlertLists]);
  
  const combinedXPosts = useMemo(() => {
    const posts: EnhancedXPost[] = [];
    
    if (xPostsData) {
      posts.push(...xPostsData.map(p => ({
        ...p,
        sourceAccount: p.sourceAccount || 'SecWar',
      })));
    }
    
    if (rapidResponseData) {
      posts.push(...rapidResponseData.map(p => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: 'Rapidresponse47',
        accountCategory: 'default',
        isRetweet: false,
        retweetedFrom: null,
        scrapedAt: p.scrapedAt,
        mediaScrapedAt: null,
        imageUrl: null,
        isHidden: false,
      })));
    }
    
    if (dowResponseData) {
      posts.push(...dowResponseData.map(p => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: 'DOWResponse',
        accountCategory: 'default',
        isRetweet: false,
        retweetedFrom: null,
        scrapedAt: p.scrapedAt,
        mediaScrapedAt: null,
        imageUrl: null,
        isHidden: false,
      })));
    }
    
    if (sentDefenderData) {
      posts.push(...sentDefenderData.map(p => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: 'sentdefender',
        accountCategory: 'default',
        isRetweet: false,
        retweetedFrom: null,
        scrapedAt: p.scrapedAt,
        mediaScrapedAt: null,
        imageUrl: p.imageUrl || null,
        videoUrl: p.videoUrl || null,
        isHidden: false,
      })));
    }

    if (warScreenshots.length > 0) {
      posts.push(...warScreenshots.map(ss => ({
        id: ss.id,
        postId: `screenshot-${ss.id}`,
        content: ss.caption,
        postedAt: ss.createdAt,
        xUrl: ss.linkUrl || '#',
        sourceAccount: 'other',
        accountCategory: 'default',
        isRetweet: false,
        retweetedFrom: null,
        scrapedAt: ss.createdAt,
        mediaScrapedAt: null,
        imageUrl: ss.imageUrl,
        isHidden: false,
      })));
    }
    
    return posts.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
  }, [xPostsData, rapidResponseData, dowResponseData, sentDefenderData, warScreenshots]);
  
  const filteredXPosts = useMemo(() => {
    if (selectedXAccounts.size === 0) return [];
    return combinedXPosts.filter(p => selectedXAccounts.has(p.sourceAccount));
  }, [combinedXPosts, selectedXAccounts]);
  
  const influencerXPosts = useMemo<EnhancedXPost[]>(() => {
    if (!influencerXPostsData) return [];
    return influencerXPostsData
      .map(p => ({ ...p, sourceAccount: p.sourceAccount || '' }))
      .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
  }, [influencerXPostsData]);
  
  const filteredInfluencerXPosts = useMemo(() => {
    if (selectedInfluencerXAccounts.size === 0) return [];
    return influencerXPosts.filter(p => selectedInfluencerXAccounts.has(p.sourceAccount));
  }, [influencerXPosts, selectedInfluencerXAccounts]);
  
  const { data: publicSearchData } = useQuery<{ 
    submissions: Array<{
      id: string;
      headline: string;
      summary: string;
      sourceUrl: string;
      sourceName: string | null;
      topicName: string;
      priorityScore: number | null;
      createdAt: string;
      publishedAt: string | null;
    }> 
  }>({
    queryKey: ['/api/public-search', { q: headerSearchQuery }],
    enabled: headerSearchQuery.trim().length >= 2,
  });
  
  const searchResults = useMemo(() => {
    if (!headerSearchQuery.trim()) return { headlines: [] as Headline[], teamSubmissions: [] as any[] };
    const query = headerSearchQuery.toLowerCase();
    
    const headlineResults = topStories.filter(h => 
      h.title.toLowerCase().includes(query) ||
      (h.source && h.source.toLowerCase().includes(query)) ||
      (h.summary && h.summary.toLowerCase().includes(query))
    );
    
    const teamResults = (publicSearchData?.submissions || []).map(sub => ({
      id: sub.id,
      headline: sub.headline,
      summary: sub.summary,
      url: sub.sourceUrl,
      sourceName: sub.sourceName,
      topicName: sub.topicName,
      priorityScore: sub.priorityScore,
      createdAt: sub.createdAt,
      publishedAt: sub.publishedAt
    }));
    
    return { headlines: headlineResults, teamSubmissions: teamResults };
  }, [headerSearchQuery, topStories, publicSearchData]);
  
  const totalSearchResults = searchResults.headlines.length + searchResults.teamSubmissions.length;
  
  const isLoading = isStreamLoading;
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-700/50 bg-slate-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-[1920px] mx-auto px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="h-6 w-6 text-blue-500" />
              <h1 className="text-lg font-bold tracking-tight">
                WAR DASHBOARD
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/war-admin">
                <span className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer" data-testid="war-link-admin">
                  <Shield className="h-3.5 w-3.5" />
                  Admin
                </span>
              </Link>
              <button
                onClick={() => setMcopBotOpen(true)}
                className="flex items-center gap-2 hover:bg-slate-700/50 rounded-full px-3 py-1 transition-colors"
                data-testid="war-button-mcopBot"
              >
                <img 
                  src={mcopBotIcon} 
                  alt="MCOP Bot" 
                  className="w-7 h-7 object-cover rounded-full"
                />
                <span className="text-xs font-medium text-blue-400">Ask MCOP Bot</span>
              </button>
              <div className="flex gap-1.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                  <Input
                    placeholder="Search headlines..."
                    value={headerSearchQuery}
                    onChange={(e) => setHeaderSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && headerSearchQuery.trim()) {
                        e.preventDefault();
                        setSearchDialogOpen(true);
                      }
                    }}
                    className="pl-8 w-40 h-8 text-xs bg-slate-800 border-slate-600 text-slate-200 placeholder:text-slate-500"
                    data-testid="war-input-search"
                  />
                </div>
                <Button 
                  size="icon"
                  variant="outline"
                  onClick={() => headerSearchQuery.trim() && setSearchDialogOpen(true)}
                  disabled={!headerSearchQuery.trim()}
                  className="h-8 w-8 border-slate-600 text-slate-400 hover:text-white"
                  data-testid="war-button-search"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ThemeToggle />
              <Link href="/">
                <span className="text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer" data-testid="war-link-back-dashboard">
                  Back to Dashboard
                </span>
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 pt-2 border-t border-slate-700/30">
            <span className="text-xs font-medium text-slate-400">Show Columns:</span>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showTopStories}
                onChange={(e) => setShowTopStories(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="war-toggle-top-stories"
              />
              <span className="text-xs text-slate-300">Top Stories</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showTruthSocial}
                onChange={(e) => setShowTruthSocial(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="war-toggle-truth-social"
              />
              <span className="text-xs text-slate-300">POTUS Truth Social</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showXFeeds}
                onChange={(e) => setShowXFeeds(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="war-toggle-x-feeds"
              />
              <span className="text-xs text-slate-300">X Feeds</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showInfluencerXPosts}
                onChange={(e) => setShowInfluencerXPosts(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="war-toggle-influencer-x-posts"
              />
              <span className="text-xs text-slate-300">Influencer X Posts</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showFirstAlert}
                onChange={(e) => setShowFirstAlert(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="war-toggle-first-alert"
              />
              <span className="text-xs text-slate-300">DATAMINR</span>
            </label>
          </div>
        </div>
      </header>
      
      <main className="max-w-[1920px] mx-auto p-4">
        <div className="flex gap-4 h-[calc(100vh-120px)]">
          {showTopStories && (
            <div className="flex-[3] min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                  TOP STORIES <span className="text-slate-500 font-normal">(ROTATING)</span>
                </h2>
                <ExternalLink className="w-4 h-4 text-slate-500" />
              </div>
              <div className="flex-1 bg-slate-800/30 rounded-2xl p-3 border border-slate-700/30">
                <TopStoriesCarousel stories={topStories} />
              </div>
            </div>
          )}
          
          {showTruthSocial && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                  POTUS TRUTH SOCIAL
                </h2>
                <span className="text-red-400 font-bold text-xs">Truth.</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {truthSocialPosts.slice(0, 10).map((post) => (
                  <TruthSocialCard key={post.id} post={post} />
                ))}
              </div>
            </div>
          )}
          
          {showXFeeds && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                  X FEEDS
                </h2>
                <div className="relative">
                  <button
                    onClick={() => setXFilterOpen(!xFilterOpen)}
                    className="text-[10px] bg-slate-700/50 hover:bg-slate-600/50 px-2 py-1 rounded flex items-center gap-1"
                    data-testid="x-filter-button"
                  >
                    Filter ({selectedXAccounts.size}/{X_ACCOUNTS.length})
                  </button>
                  {xFilterOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 min-w-[160px]">
                      {X_ACCOUNTS.map(account => (
                        <label
                          key={account.id}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-slate-700/50 cursor-pointer text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={selectedXAccounts.has(account.id)}
                            onChange={() => toggleXAccount(account.id)}
                            className="rounded border-slate-500"
                            data-testid={`x-filter-${account.id}`}
                          />
                          {account.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {filteredXPosts.slice(0, 15).map((post) => (
                  <XPostCard key={post.id} post={post} />
                ))}
                {filteredXPosts.length === 0 && (
                  <div className="text-center text-slate-500 text-xs py-4">
                    No accounts selected
                  </div>
                )}
              </div>
            </div>
          )}
          
          {showInfluencerXPosts && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                  INFLUENCER X POSTS
                </h2>
                <div className="relative">
                  <button
                    onClick={() => setInfluencerXFilterOpen(!influencerXFilterOpen)}
                    className="text-[10px] bg-slate-700/50 hover:bg-slate-600/50 px-2 py-1 rounded flex items-center gap-1"
                    data-testid="influencer-x-filter-button"
                  >
                    Filter ({selectedInfluencerXAccounts.size}/{INFLUENCER_X_ACCOUNTS.length})
                  </button>
                  {influencerXFilterOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 min-w-[180px] max-h-[400px] overflow-y-auto">
                      {INFLUENCER_X_ACCOUNTS.map(account => (
                        <label
                          key={account.id}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-slate-700/50 cursor-pointer text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={selectedInfluencerXAccounts.has(account.id)}
                            onChange={() => toggleInfluencerXAccount(account.id)}
                            className="rounded border-slate-500"
                            data-testid={`influencer-x-filter-${account.id}`}
                          />
                          {account.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {filteredInfluencerXPosts.slice(0, 30).map((post) => (
                  <XPostCard key={post.id} post={post} />
                ))}
                {filteredInfluencerXPosts.length === 0 && (
                  <div className="text-center text-slate-500 text-xs py-4">
                    {selectedInfluencerXAccounts.size === 0 ? 'No accounts selected' : 'No posts yet'}
                  </div>
                )}
              </div>
            </div>
          )}
          
          {showFirstAlert && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                    DATAMINR
                  </h2>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setListFilterOpen(true)}
                    className="h-6 w-6"
                    data-testid="button-war-filter-lists"
                  >
                    <Filter className="h-3 w-3" />
                  </Button>
                </div>
                <span className="text-xs text-slate-500">
                  {filteredFirstAlerts.length} alerts
                </span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {filteredFirstAlerts.slice(0, 30).map((alert) => (
                  <FirstAlertCard key={alert.id} alert={alert} />
                ))}
              </div>
            </div>
          )}
          
          {!showTopStories && !showTruthSocial && !showXFeeds && !showInfluencerXPosts && !showFirstAlert && (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <p className="text-sm">No columns selected. Use the toggles above to show columns.</p>
            </div>
          )}
        </div>
      </main>
      
      <TopicFilterDialog
        open={listFilterOpen}
        onOpenChange={setListFilterOpen}
        availableLists={availableAlertLists}
        selectedLists={selectedAlertLists}
        onListsChange={setSelectedAlertLists}
      />
      
      <MCOPBotDialog open={mcopBotOpen} onOpenChange={setMcopBotOpen} />

      <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle data-testid="war-search-dialog-title">
              Search Results for "{headerSearchQuery}" ({totalSearchResults} found)
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            <div className="space-y-4 pr-2">
              {totalSearchResults === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="text-sm">No results found matching "{headerSearchQuery}"</p>
                </div>
              ) : (
                <>
                  {searchResults.teamSubmissions.length > 0 && (
                    <div className="space-y-2">
                      {searchResults.teamSubmissions.map((submission: any) => (
                        <a
                          key={`team-${submission.id}`}
                          href={submission.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block p-3 rounded-md border hover-elevate"
                          data-testid={`war-search-result-team-${submission.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <h3 className="text-sm font-medium line-clamp-2">{submission.headline}</h3>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                <span className="font-medium">{submission.topicName}</span>
                                <span>•</span>
                                <span>{formatTimeAgo(new Date(submission.publishedAt || submission.createdAt))}</span>
                              </div>
                              {submission.summary && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{submission.summary}</p>
                              )}
                            </div>
                            <ExternalLink className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                          </div>
                        </a>
                      ))}
                    </div>
                  )}

                  {searchResults.headlines.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground border-b pb-1">
                        <Newspaper className="w-3 h-3" />
                        <span>Headlines ({searchResults.headlines.length})</span>
                      </div>
                      {searchResults.headlines.map((headline) => (
                        <a
                          key={headline.id}
                          href={headline.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block p-3 rounded-md border hover-elevate"
                          data-testid={`war-search-result-${headline.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <h3 className="text-sm font-medium line-clamp-2">{headline.title}</h3>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                <span>{headline.source}</span>
                                <span>•</span>
                                <span>{headline.articlePublishedAt ? new Date(headline.articlePublishedAt).toLocaleTimeString() : new Date(headline.scrapedAt).toLocaleTimeString()}</span>
                              </div>
                              {headline.summary && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{headline.summary}</p>
                              )}
                            </div>
                            <ExternalLink className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
