import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Shield, ExternalLink, ChevronLeft, ChevronRight, MapPin, AlertTriangle, Filter, Search, Send, Loader2, Play, Download, FileText, Loader } from "lucide-react";
import { Link } from "wouter";
import { cleanTruthContent } from "@/lib/cleanTruthContent";
import TopicFilterDialog from "@/components/TopicFilterDialog";
import ViewSwitcher from "@/components/ViewSwitcher";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import MarketTicker from "@/components/MarketTicker";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import mcopLogoWhite from "@assets/Logo5_WHITE_1782606805634.png";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";
import CuratedNudge from "@/components/CuratedNudge";
import type { Headline, TruthSocialPost, XPost, FirstAlert, RapidResponsePost, DOWResponsePost, SentDefenderPost, OsintPost } from "@shared/schema";

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
    // For archive.is URLs, the frontend can't extract the original source,
    // so return null and let the server handle it via the logo fallback with domain extraction
    if (hostname.includes('archive.is') || hostname.includes('archive.ph') || hostname.includes('archive.org')) {
      return null;
    }
    return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${hostname}&size=128`;
  } catch {
    return null;
  }
}

function StoryCard({ story, isVisible, compactImages }: { story: StreamHeadline; isVisible: boolean; compactImages?: boolean }) {
  const isVideo = story.imageUrl?.startsWith('VIDEO:');
  const mediaUrl = isVideo ? story.imageUrl?.replace('VIDEO:', '') : story.imageUrl;
  const isLogoFallback = mediaUrl?.includes('logo.clearbit.com') || mediaUrl?.includes('gstatic.com/faviconV2');
  const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const isTooSmallOrBanner = imgNaturalSize && (
    imgNaturalSize.w < 200 || imgNaturalSize.h < 120 ||
    (imgNaturalSize.w / imgNaturalSize.h > 4)
  );
  
  return (
    <a
      href={story.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group relative rounded-xl overflow-hidden bg-slate-800/50 hover:bg-slate-700/50 transition-all [transition-duration:3000ms] flex flex-col ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      data-testid={`stream-story-${story.id}`}
    >
      <div className={`relative ${compactImages ? 'h-32' : 'h-44'} overflow-hidden`}>
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
              className={`group-hover:scale-105 transition-transform duration-500 ${
                isTooSmallOrBanner 
                  ? 'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[60%] max-h-[60%] object-contain opacity-70' 
                  : 'w-full h-full object-cover'
              }`}
              onLoad={(e) => {
                const img = e.target as HTMLImageElement;
                setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                const logoUrl = getOutletLogoUrl(story.url);
                if (logoUrl && !img.dataset.triedLogo) {
                  img.dataset.triedLogo = 'true';
                  img.className = 'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 object-contain opacity-70';
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

function TopStoriesCarousel({ stories, compactImages }: { stories: StreamHeadline[]; compactImages?: boolean }) {
  const [slotStates, setSlotStates] = useState<{storyIndex: number; phase: string}[]>([
    { storyIndex: 0, phase: 'visible' },
    { storyIndex: 1, phase: 'visible' },
    { storyIndex: 2, phase: 'visible' },
    { storyIndex: 3, phase: 'visible' },
  ]);
  const [nextSlotToUpdate, setNextSlotToUpdate] = useState(0);
  const preloadedImages = useRef<Set<string>>(new Set());
  
  const limitedStories = useMemo(() => stories.slice(0, 8), [stories]);
  const totalStories = limitedStories.length;

  const getNextStoryIndex = useCallback((currentStates: {storyIndex: number}[]) => {
    const currentIndices = currentStates.map(s => s.storyIndex);
    let nextIdx = (Math.max(...currentIndices) + 1) % totalStories;
    while (currentIndices.includes(nextIdx)) {
      nextIdx = (nextIdx + 1) % totalStories;
    }
    return nextIdx;
  }, [totalStories]);

  const preloadImage = useCallback((url: string | undefined) => {
    if (!url || preloadedImages.current.has(url)) return;
    const isVideo = url.startsWith('VIDEO:');
    if (isVideo) return;
    const img = new Image();
    img.src = url;
    preloadedImages.current.add(url);
  }, []);
  
  useEffect(() => {
    if (totalStories <= 4) return;
    
    const interval = setInterval(() => {
      const slotToUpdate = nextSlotToUpdate;

      setSlotStates(prev => {
        const nextIdx = getNextStoryIndex(prev);
        const nextStory = limitedStories[nextIdx];
        if (nextStory?.imageUrl) preloadImage(nextStory.imageUrl);

        const newStates = [...prev];
        newStates[slotToUpdate] = { ...newStates[slotToUpdate], phase: 'darkening' };
        return newStates;
      });
      
      setTimeout(() => {
        setSlotStates(prev => {
          const nextIdx = getNextStoryIndex(prev);
          const newStates = [...prev];
          newStates[slotToUpdate] = { storyIndex: nextIdx, phase: 'dark' };
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
        }, 100);
      }, 3000);
      
      setNextSlotToUpdate(prev => (prev + 1) % 4);
    }, 15000);
    
    return () => clearInterval(interval);
  }, [totalStories, nextSlotToUpdate, getNextStoryIndex, limitedStories, preloadImage]);
  
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
  
  // Get brightness class based on phase
  const getBrightnessStyle = (phase: string) => {
    switch (phase) {
      case 'darkening':
        return { filter: 'brightness(0)', transition: 'filter 3s ease-in-out' };
      case 'dark':
        return { filter: 'brightness(0)', transition: 'none' };
      case 'brightening':
        return { filter: 'brightness(1)', transition: 'filter 2s ease-in-out' };
      default: // 'visible'
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
                compactImages={compactImages}
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

function StreamPostVideo({ videoUrl, thumbnailUrl, truthSocialUrl, postId }: { videoUrl: string; thumbnailUrl?: string | null; truthSocialUrl: string; postId: string }) {
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
  const [imgTooSmall, setImgTooSmall] = useState(false);
  // Match Truth Social's own behavior: show post.imageUrl when set, otherwise
  // nothing. Do NOT scan post.content for embedded URLs — that pulls Trump's
  // profile/header image out of the post HTML and attaches it as a fake
  // attachment on text-only posts.
  const rawMediaUrl = post.imageUrl;
  const isLogoOrFavicon = rawMediaUrl && (
    rawMediaUrl.includes('logo.clearbit.com') ||
    rawMediaUrl.includes('gstatic.com/faviconV2') ||
    rawMediaUrl.includes('/favicon') ||
    rawMediaUrl.includes('/apple-touch-icon') ||
    rawMediaUrl.includes('/site-icon') ||
    /\/icons?\//i.test(rawMediaUrl)
  );
  const mediaUrl = isLogoOrFavicon ? null : rawMediaUrl;
  const cleanContent = cleanTruthContent(post.content).replace(/https?:\/\/[^\s]+/g, '').trim();
  const showContent = cleanContent && cleanContent !== '[Media attachment]';
  
  return (
    <a
      href={post.truthSocialUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 transition-colors border border-slate-700/50"
      data-testid={`stream-truth-${post.id}`}
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
          <StreamPostVideo
            videoUrl={post.videoUrl}
            thumbnailUrl={post.videoThumbnailUrl}
            truthSocialUrl={post.truthSocialUrl}
            postId={post.id}
          />
        )}
        {mediaUrl && !post.videoUrl && !imgFailed && !imgTooSmall && (
          <div className="mt-2 rounded-lg overflow-hidden">
            <img 
              src={mediaUrl} 
              alt="Post attachment" 
              className="w-full h-auto max-h-48 object-contain bg-black/20"
              loading="lazy"
              onLoad={(e) => {
                const img = e.target as HTMLImageElement;
                if (img.naturalWidth < 200 || img.naturalHeight < 120 || (img.naturalWidth / img.naturalHeight > 5)) {
                  setImgTooSmall(true);
                }
              }}
              onError={() => setImgFailed(true)}
            />
          </div>
        )}
      </div>
    </a>
  );
}

function XPostCard({ post }: { post: EnhancedXPost & { originalAccount?: string } }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const mediaUrl = post.imageUrl || extractMediaUrl(post.content);
  const cleanContent = post.content.replace(/https?:\/\/[^\s]+/g, '').trim();
  
  // Get display name and color based on source account
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
      case 'SecRubio':
        return { initial: 'R', name: '@SecRubio', gradient: 'from-violet-500 to-purple-600' };
      case 'MATA_osint':
        return { initial: 'M', name: '@MATA_osint', gradient: 'from-amber-500 to-orange-600' };
      case 'flightTracking':
        return { initial: 'F', name: post.originalAccount ? `@${post.originalAccount}` : 'Flight Tracking', gradient: 'from-emerald-500 to-green-600' };
      default:
        return { initial: account.charAt(0).toUpperCase(), name: `@${account}`, gradient: 'from-gray-500 to-slate-600' };
    }
  };
  
  const accountStyle = getAccountStyle(post.sourceAccount);
  
  return (
    <a
      href={post.xUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 transition-colors border border-slate-700/50"
      data-testid={`stream-x-${post.id}`}
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
        <div className="text-xs text-slate-200 leading-relaxed">
          {(cleanContent || post.content).split('\n').map((line: string, i: number) => {
            if (line.startsWith('RT @')) {
              return <span key={i} className="block mt-2 text-[11px] text-slate-400 italic border-l-2 border-slate-600 pl-2">{line}</span>;
            }
            if (line.trim() === '') return null;
            return <span key={i} className="block">{line}</span>;
          })}
        </div>
        {post.videoUrl && post.videoUrl.startsWith('http') && !post.videoUrl.includes('x.com/') && !videoFailed ? (
          <div className="mt-2 rounded-lg overflow-hidden">
            <video
              data-testid={`video-player-${post.postId}`}
              src={post.videoUrl}
              autoPlay
              muted
              loop
              playsInline
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
    </a>
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
      data-testid={`stream-alert-${alert.id}`}
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
  { id: 'SecRubio', label: '@SecRubio' },
  { id: 'sentdefender', label: 'OSINT X' },
  { id: 'DOWResponse', label: '@DOWResponse' },
  { id: 'Rapidresponse47', label: '@Rapidresponse47' },
  { id: 'MATA_osint', label: '@MATA_osint' },
  { id: 'CENTCOM', label: '@CENTCOM' },
  { id: 'SOUTHCOM', label: '@SOUTHCOM' },
  { id: 'flightTracking', label: 'Other Flight Tracking' },
];

export default function Stream() {
  // Curated View access (separate tester allowlist) — controls Curated link visibility
  const { data: curatedAccess } = useQuery<{ hasCuratedAccess: boolean }>({
    queryKey: ['/api/auth/curated-access'],
    retry: false,
  });

  // Fetch stream data for top stories, truth social, and first alerts
  const { data: streamData, isLoading: isStreamLoading } = useQuery<StreamData>({
    queryKey: ['/api/stream'],
  });
  
  // Fetch X posts from separate endpoints like the main page does
  const { data: xPostsData } = useQuery<XPost[]>({
    queryKey: ['/api/x-posts'],
  });
  
  const { data: rapidResponseData } = useQuery<RapidResponsePost[]>({
    queryKey: ['/api/rapidresponse-posts'],
  });
  
  const { data: dowResponseData } = useQuery<DOWResponsePost[]>({
    queryKey: ['/api/dowresponse-posts'],
  });
  
  const { data: sentDefenderData } = useQuery<SentDefenderPost[]>({
    queryKey: ['/api/sentdefender-posts'],
  });
  
  const { data: latestScrub } = useQuery<{ id: string; caoDate: string; filename: string; hasHtml: boolean }>({
    queryKey: ['/api/daily-news-scrub/latest'],
    refetchInterval: 60000,
    retry: false,
  });

  const [scrubViewerOpen, setScrubViewerOpen] = useState(false);

  const { data: scrubHtmlData, isLoading: scrubHtmlLoading } = useQuery<{ htmlContent: string }>({
    queryKey: ['/api/daily-news-scrub', latestScrub?.id, 'html'],
    queryFn: async () => {
      const res = await fetch(`/api/daily-news-scrub/${latestScrub!.id}/html`, { credentials: 'include' });
      if (!res.ok) throw new Error('No HTML available');
      return res.json();
    },
    enabled: scrubViewerOpen && !!latestScrub?.id && !!latestScrub?.hasHtml,
    retry: false,
  });

  const { data: osintData } = useQuery<OsintPost[]>({
    queryKey: ['/api/osint-posts'],
  });

  const { data: flightTrackingData } = useQuery<any[]>({
    queryKey: ['/api/flight-tracking/posts'],
  });
  const [showTopStories, setShowTopStories] = useState(() => {
    const saved = localStorage.getItem('streamShowTopStories');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showTruthSocial, setShowTruthSocial] = useState(() => {
    const saved = localStorage.getItem('streamShowTruthSocial');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showXFeeds, setShowXFeeds] = useState(() => {
    const saved = localStorage.getItem('streamShowXFeeds');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showTicker, setShowTicker] = useState(() => {
    const saved = localStorage.getItem('showTicker');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [showFirstAlert, setShowFirstAlert] = useState(() => {
    const saved = localStorage.getItem('streamShowFirstAlert');
    return saved !== null ? JSON.parse(saved) : true;
  });
  
  // Persist column visibility to localStorage
  useEffect(() => {
    localStorage.setItem('streamShowTopStories', JSON.stringify(showTopStories));
  }, [showTopStories]);
  useEffect(() => {
    localStorage.setItem('streamShowTruthSocial', JSON.stringify(showTruthSocial));
  }, [showTruthSocial]);
  useEffect(() => {
    localStorage.setItem('streamShowXFeeds', JSON.stringify(showXFeeds));
  }, [showXFeeds]);
  useEffect(() => {
    localStorage.setItem('streamShowFirstAlert', JSON.stringify(showFirstAlert));
  }, [showFirstAlert]);
  useEffect(() => {
    localStorage.setItem('showTicker', JSON.stringify(showTicker));
  }, [showTicker]);
  
  const DEFAULT_OFF_X_ACCOUNTS = new Set(['DOWResponse', 'Rapidresponse47']);
  // X feed filter state - default to all accounts selected except DEFAULT_OFF
  // For returning users, any newly added feed (not in their saved list and not default-off) is auto-enabled
  const [selectedXAccounts, setSelectedXAccounts] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('streamXAccountFilter');
    if (saved) {
      try {
        const savedArr = JSON.parse(saved) as string[];
        const savedSet = new Set(savedArr);
        const allIds = new Set(X_ACCOUNTS.map(a => a.id));
        const result = new Set(savedArr.filter(id => allIds.has(id)));
        for (const a of X_ACCOUNTS) {
          if (!savedSet.has(a.id) && !DEFAULT_OFF_X_ACCOUNTS.has(a.id)) {
            result.add(a.id);
          }
        }
        return result;
      } catch {
        return new Set(X_ACCOUNTS.map(a => a.id));
      }
    }
    return new Set(X_ACCOUNTS.map(a => a.id).filter(id => !DEFAULT_OFF_X_ACCOUNTS.has(id)));
  });
  const [xFilterOpen, setXFilterOpen] = useState(false);
  
  // Save filter to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('streamXAccountFilter', JSON.stringify(Array.from(selectedXAccounts)));
  }, [selectedXAccounts]);
  
  // MCOP Bot AI assistant state
  const [mcopBotOpen, setMcopBotOpen] = useState(false);
  
  // Search bar state
  const [headerSearchQuery, setHeaderSearchQuery] = useState('');
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  
  // DataMinr list filter state
  const [listFilterOpen, setListFilterOpen] = useState(false);
  const [selectedAlertLists, setSelectedAlertLists] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('streamSelectedAlertLists');
      return saved !== null ? JSON.parse(saved) : [];
    } catch (error) {
      console.error('Failed to parse selected alert lists from localStorage:', error);
      return [];
    }
  });
  
  // Persist DataMinr list filter to localStorage
  useEffect(() => {
    localStorage.setItem('streamSelectedAlertLists', JSON.stringify(selectedAlertLists));
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
  
  // Auto-refresh + manual refresh controls (mirrors the Classic Dashboard)
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAllData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/stream'] });
    queryClient.invalidateQueries({ queryKey: ['/api/x-posts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/rapidresponse-posts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/dowresponse-posts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/sentdefender-posts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/osint-posts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/flight-tracking/posts'] });
  }, []);

  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    try {
      setIsRefreshing(true);
      await apiRequest('POST', '/api/scrape', {});
      await apiRequest('POST', '/api/scrape-truth-social', {});
      await apiRequest('POST', '/api/scrape-x', {});
      await apiRequest('POST', '/api/scrape-rapidresponse', {});
      await apiRequest('POST', '/api/scrape-dowresponse', {});
      await apiRequest('POST', '/api/scrape-first-alerts', {});
      refreshAllData();
    } catch (error) {
      console.error('Error triggering manual scrape:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      refreshAllData();
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshAllData]);

  const topStories = streamData?.topStories || [];
  const truthSocialPosts = streamData?.truthSocialPosts || [];
  const firstAlerts = streamData?.firstAlerts || [];
  
  // Available alert lists with counts for DataMinr filter
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
  
  // Filter and sort first alerts: Flash alerts prioritized at top
  const filteredFirstAlerts = useMemo(() => {
    let filtered = firstAlerts;
    
    // Apply command list filter if any lists are selected
    if (selectedAlertLists.length > 0) {
      filtered = firstAlerts.filter(alert => {
        if (!alert.alertLists || alert.alertLists.length === 0) {
          return false;
        }
        return alert.alertLists.some(list => selectedAlertLists.includes(list));
      });
    }
    
    // Sort: Flash alerts first (most recent to oldest), then other alerts (most recent to oldest)
    return filtered.sort((a, b) => {
      const aIsFlash = a.alertType === 'Flash';
      const bIsFlash = b.alertType === 'Flash';
      
      if (aIsFlash && !bIsFlash) return -1;
      if (!aIsFlash && bIsFlash) return 1;
      
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
  }, [firstAlerts, selectedAlertLists]);
  
  // Combine X posts from all sources with proper sourceAccount mapping
  const combinedXPosts = useMemo(() => {
    const posts: EnhancedXPost[] = [];
    
    // Add posts from x_posts table (SecWar and PeteHegseth)
    if (xPostsData) {
      posts.push(...xPostsData.map(p => ({
        ...p,
        sourceAccount: p.sourceAccount || 'SecWar',
      })));
    }
    
    // Add RapidResponse posts with sourceAccount
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
    
    // Add DOWResponse posts with sourceAccount
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
    
    // Add SentDefender posts with sourceAccount
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
    
    // Add OSINT posts (@MATA_osint)
    if (osintData) {
      posts.push(...osintData.map(p => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: p.sourceAccount,
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

    // Add flight tracking posts (manual uploads)
    if (flightTrackingData) {
      posts.push(...flightTrackingData.map((p: any) => ({
        id: p.id,
        postId: p.postId,
        content: p.content,
        postedAt: p.postedAt,
        xUrl: p.xUrl,
        sourceAccount: 'flightTracking',
        accountCategory: 'default',
        originalAccount: p.sourceAccount,
        isRetweet: false,
        retweetedFrom: null,
        scrapedAt: p.submittedAt,
        mediaScrapedAt: null,
        imageUrl: p.imageUrl || p.screenshotUrl || null,
        videoUrl: p.videoUrl || null,
        isHidden: false,
      })));
    }
    
    // Sort by posted date, newest first
    return posts.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
  }, [xPostsData, rapidResponseData, dowResponseData, sentDefenderData, osintData, flightTrackingData]);
  
  // Filter X posts based on selected accounts
  const filteredXPosts = useMemo(() => {
    if (selectedXAccounts.size === 0) return [];
    return combinedXPosts.filter(p => selectedXAccounts.has(p.sourceAccount));
  }, [combinedXPosts, selectedXAccounts]);
  
  // Public search for team submissions - only triggered when searching
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
  
  // Search results combining headlines and team submissions
  const searchResults = useMemo(() => {
    if (!headerSearchQuery.trim()) return [];
    
    return (publicSearchData?.submissions || []).map((sub: any) => ({
      id: sub.id,
      headline: sub.headline,
      summary: sub.summary,
      url: sub.sourceUrl,
      sourceName: sub.sourceName,
      sourceTable: sub.sourceTable || 'team_submission',
      topicName: sub.topicName,
      priorityScore: sub.priorityScore,
      createdAt: sub.createdAt,
      publishedAt: sub.publishedAt
    }));
  }, [headerSearchQuery, publicSearchData]);
  
  const totalSearchResults = searchResults.length;
  
  const isLoading = isStreamLoading;
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-slate-900 text-white stream-dark">
      <header className="border-b border-slate-700/50 bg-slate-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-[1920px] mx-auto px-4 py-2">
          <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex flex-col items-start shrink-0">
                <img
                  src={mcopLogoWhite}
                  alt="MOOP"
                  className="h-24 w-auto"
                  data-testid="stream-icon-logo"
                />
                <p className="text-[10px] text-slate-400 leading-tight" style={{ marginLeft: '5px' }} data-testid="stream-text-app-subtitle">
                  Visual View
                </p>
              </div>
              <button
                onClick={() => setMcopBotOpen(true)}
                className="ml-1 flex items-center gap-1.5 hover:bg-slate-700/50 rounded-full px-2 py-1 transition-colors shrink-0"
                data-testid="stream-button-mcopBot"
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
                    className="pl-8 w-28 h-8 text-xs bg-slate-800 border-slate-600 text-slate-200 placeholder:text-slate-500"
                    data-testid="stream-input-search"
                  />
                </div>
                <Button 
                  size="icon"
                  variant="outline"
                  onClick={() => headerSearchQuery.trim() && setSearchDialogOpen(true)}
                  disabled={!headerSearchQuery.trim()}
                  className="h-8 w-8 border-slate-600 text-slate-400 hover:text-white"
                  data-testid="stream-button-search"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {latestScrub && (
                <Button
                  variant="default"
                  size="sm"
                  className="bg-blue-600 text-white border-blue-500"
                  data-testid="stream-button-download-scrub"
                  onClick={() => setScrubViewerOpen(true)}
                >
                  <FileText className="w-4 h-4 mr-1.5" />
                  News Scrub · CAO {(() => {
                    const d = new Date(latestScrub.caoDate);
                    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mon = months[d.getMonth()];
                    const yyyy = d.getFullYear();
                    const hh = String(d.getHours()).padStart(2, '0');
                    const mm = String(d.getMinutes()).padStart(2, '0');
                    return `${dd}${mon}${yyyy} ${hh}:${mm}`;
                  })()}
                </Button>
              )}
              <div className="flex items-center gap-1.5">
                <Switch
                  id="stream-auto-refresh"
                  checked={autoRefresh}
                  onCheckedChange={setAutoRefresh}
                  data-testid="stream-switch-auto-refresh"
                />
                <label htmlFor="stream-auto-refresh" className="text-sm font-medium text-slate-300 cursor-pointer" data-testid="stream-label-auto-refresh">
                  Auto-refresh
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-600 text-slate-200"
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  data-testid="stream-button-refresh"
                >
                  {isRefreshing ? 'Refreshing...' : 'Refresh Now'}
                </Button>
              </div>
              <ViewSwitcher
                current="visual"
                tone="dark"
                hasCuratedAccess={!!curatedAccess?.hasCuratedAccess}
                labelTestId="stream-label-switch-view"
                testIds={{
                  classic: "stream-button-view-toggle",
                  visual: "stream-link-visual",
                  curated: "stream-link-curated",
                  team: "stream-link-team",
                }}
              />
            </div>
          </div>
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 pt-2 border-t border-slate-700/30">
            <span className="text-xs font-medium text-slate-400">Show Columns:</span>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showTopStories}
                onChange={(e) => setShowTopStories(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="stream-toggle-top-stories"
              />
              <span className="text-xs text-slate-300">Top Stories</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showTruthSocial}
                onChange={(e) => setShowTruthSocial(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="stream-toggle-truth-social"
              />
              <span className="text-xs text-slate-300">POTUS Truth Social</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showXFeeds}
                onChange={(e) => setShowXFeeds(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="stream-toggle-x-feeds"
              />
              <span className="text-xs text-slate-300">X Feeds</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showFirstAlert}
                onChange={(e) => setShowFirstAlert(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="stream-toggle-first-alert"
              />
              <span className="text-xs text-slate-300">DATAMINR</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showTicker}
                onChange={(e) => setShowTicker(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-blue-500"
                data-testid="stream-toggle-ticker"
              />
              <span className="text-xs text-slate-300">Market Ticker</span>
            </label>
          </div>
        </div>
      </header>
      <MarketTicker enabled={showTicker} variant="stream" />
      
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
              <div className="flex-1 bg-slate-800/30 rounded-2xl p-3 border border-slate-700/30 min-h-0 overflow-hidden">
                <TopStoriesCarousel stories={topStories} compactImages={false} />
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
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
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
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
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
                    data-testid="button-stream-filter-lists"
                  >
                    <Filter className="h-3 w-3" />
                  </Button>
                </div>
                <span className="text-xs text-slate-500">
                  {filteredFirstAlerts.length} alerts
                </span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {filteredFirstAlerts.slice(0, 30).map((alert) => (
                  <FirstAlertCard key={alert.id} alert={alert} />
                ))}
              </div>
            </div>
          )}
          
          {!showTopStories && !showTruthSocial && !showXFeeds && !showFirstAlert && (
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

      {/* Search Results Dialog */}
      <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle data-testid="stream-search-dialog-title">
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
                  {searchResults.length > 0 && (
                    <div className="space-y-2">
                      {searchResults.map((result: any) => (
                        <a
                          key={`search-${result.sourceTable}-${result.id}`}
                          href={result.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block p-3 rounded-md border hover-elevate"
                          data-testid={`stream-search-result-${result.sourceTable}-${result.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <h3 className="text-sm font-medium line-clamp-2">{result.headline}</h3>
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                  {result.sourceTable === 'team_submission' ? 'Team' :
                                   result.sourceTable === 'mcop_feed' ? 'MCOP' :
                                   result.sourceTable === 'headline' ? 'Headline' :
                                   result.sourceTable === 'rss_bot' ? 'RSS' : 'News'}
                                </Badge>
                                {result.sourceName && <span className="font-medium">{result.sourceName}</span>}
                                <span>•</span>
                                <span>{formatTimeAgo(new Date(result.publishedAt || result.createdAt))}</span>
                              </div>
                              {result.summary && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{result.summary}</p>
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

      {latestScrub && (
        <Dialog open={scrubViewerOpen} onOpenChange={setScrubViewerOpen}>
          <DialogContent className="max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 overflow-visible" onInteractOutside={(e) => e.preventDefault()}>
            <DialogHeader className="flex flex-row items-center justify-between px-6 py-4 border-b shrink-0">
              <div className="flex items-center gap-3">
                <FileText className="w-6 h-6 text-primary" />
                <div>
                  <DialogTitle className="text-lg font-semibold" data-testid="stream-scrub-viewer-title">
                    Current News Scrub
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    CAO {(() => {
                      const d = new Date(latestScrub.caoDate);
                      const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
                      const dd = String(d.getDate()).padStart(2, '0');
                      const mon = months[d.getMonth()];
                      const yyyy = d.getFullYear();
                      const hh = String(d.getHours()).padStart(2, '0');
                      const mm = String(d.getMinutes()).padStart(2, '0');
                      return `${dd}${mon}${yyyy} ${hh}:${mm}`;
                    })()} — {latestScrub.filename}
                  </p>
                </div>
              </div>
              <a href={`/api/daily-news-scrub/${latestScrub.id}/download`} download>
                <Button variant="default" data-testid="stream-button-scrub-viewer-download">
                  <Download className="w-4 h-4 mr-2" />
                  Download PDF
                </Button>
              </a>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {latestScrub.hasHtml && scrubHtmlData?.htmlContent ? (
                <div
                  className="news-scrub-viewer px-8 py-6 max-w-4xl mx-auto"
                  dangerouslySetInnerHTML={{ __html: scrubHtmlData.htmlContent }}
                  data-testid="stream-scrub-viewer-html"
                />
              ) : latestScrub.hasHtml && scrubHtmlLoading ? (
                <div className="flex items-center justify-center h-full gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <span className="text-muted-foreground">Loading formatted content...</span>
                </div>
              ) : (
                <iframe
                  src={`/api/daily-news-scrub/${latestScrub.id}/download?inline=true`}
                  className="w-full h-full border-0"
                  title="News Scrub PDF Viewer"
                  data-testid="stream-scrub-viewer-iframe"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      <CuratedNudge />
    </div>
  );
}
