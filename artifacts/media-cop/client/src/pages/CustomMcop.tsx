import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import {
  Shield, ExternalLink, ChevronLeft, ChevronRight, MapPin, AlertTriangle,
  Filter, Loader2, Settings, ArrowLeft, Search, Newspaper
} from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import TopicFilterDialog from "@/components/TopicFilterDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cleanTruthContent } from "@/lib/cleanTruthContent";
import { WarfighterGate } from "@/components/WarfighterGate";
import mcopBotIcon from "@assets/generated_images/mcop_bot_robot_mascot_icon.png";
import { MCOPBotDialog } from "@/components/MCOPBotDialog";
import type {
  Headline, TruthSocialPost, XPost, FirstAlert, CustomMcopScreenshot
} from "@shared/schema";
import { INFLUENCER_X_ACCOUNTS } from "@shared/influencerXAccounts";

interface StreamHeadline extends Headline {
  imageUrl?: string | null;
  isCustomArticle?: boolean;
}

type EnhancedXPost = XPost & {
  videoUrl?: string | null;
  sourceType?: string;
};

interface FeedData {
  mcop: { slug: string; name: string };
  topStories: StreamHeadline[];
  truthSocialPosts: TruthSocialPost[];
  xPosts: EnhancedXPost[];
  influencerXPosts?: EnhancedXPost[];
  firstAlerts: FirstAlert[];
  screenshots: CustomMcopScreenshot[];
  scoredCount: number;
  enabledXAccounts?: string[];
  enabledInfluencerXAccounts?: string[];
  isMcopAdmin?: boolean;
}

const X_ACCOUNTS = [
  { id: 'SecWar', label: '@SecWar' },
  { id: 'PeteHegseth', label: '@PeteHegseth' },
  { id: 'SeanParnellASW', label: '@SeanParnellASW' },
  { id: 'DOWResponse', label: '@DOWResponse' },
  { id: 'TheJointStaff', label: '@TheJointStaff' },
  { id: 'SecArmy', label: '@SecArmy' },
  { id: 'SecAFOfficial', label: '@SecAFOfficial' },
  { id: 'SecRubio', label: '@SecRubio' },
  { id: 'SenMarcoRubio', label: '@SenMarcoRubio' },
  { id: 'PressSec', label: '@PressSec' },
  { id: 'Rapidresponse47', label: '@Rapidresponse47' },
  { id: 'sentdefender', label: '@sentdefender' },
];

function formatTimeAgo(date: Date): string {
  const diffMins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const h = Math.floor(diffMins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getOutletLogoUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('archive.')) return null;
    return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${hostname}&size=128`;
  } catch { return null; }
}

function StoryCard({ story, slug, isAdmin, isVisible }: { story: StreamHeadline; slug: string; isAdmin: boolean; isVisible: boolean }) {
  const isVideo = story.imageUrl?.startsWith('VIDEO:');
  const mediaUrl = isVideo ? story.imageUrl?.replace('VIDEO:', '') : story.imageUrl;
  const isLogoFallback = mediaUrl?.includes('logo.clearbit.com') || mediaUrl?.includes('gstatic.com/faviconV2');

  return (
    <a
      href={story.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group relative rounded-xl overflow-hidden bg-slate-800/50 hover:bg-slate-700/50 transition-all [transition-duration:3000ms] flex flex-col ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      data-testid={`mcop-story-${story.id}`}
    >
      <div className="relative h-44 overflow-hidden">
        {isVideo && mediaUrl ? (
          <video src={mediaUrl} autoPlay muted loop playsInline className="w-full h-full object-cover" />
        ) : mediaUrl && !isLogoFallback ? (
          <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-800 relative">
            <img
              src={mediaUrl} alt=""
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
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center">
            <Shield className="w-10 h-10 text-slate-600" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        {story.source && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold bg-blue-600 text-white uppercase">
            {story.source}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-base font-bold text-white leading-snug group-hover:text-blue-400 transition-colors">
          {story.title}
        </h3>
        {story.summaryBullets && story.summaryBullets.length > 0 && (
          <ul className="mt-2 space-y-1">
            {story.summaryBullets.slice(0, 3).map((b, i) => (
              <li key={i} className="text-sm text-slate-300 flex items-start gap-1.5">
                <span className="text-blue-400 mt-0.5">•</span><span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </a>
  );
}

function TopStoriesCarousel({ stories, slug, isAdmin }: { stories: StreamHeadline[]; slug: string; isAdmin: boolean }) {
  const [slotStates, setSlotStates] = useState<{ storyIndex: number; phase: string }[]>([
    { storyIndex: 0, phase: 'visible' },
    { storyIndex: 1, phase: 'visible' },
    { storyIndex: 2, phase: 'visible' },
    { storyIndex: 3, phase: 'visible' },
  ]);
  const [nextSlotToUpdate, setNextSlotToUpdate] = useState(0);

  const limited = useMemo(() => stories.slice(0, 12), [stories]);
  const total = limited.length;

  useEffect(() => {
    if (total <= 4) return;
    const interval = setInterval(() => {
      const slotToUpdate = nextSlotToUpdate;
      setSlotStates(prev => {
        const ns = [...prev];
        ns[slotToUpdate] = { ...ns[slotToUpdate], phase: 'darkening' };
        return ns;
      });
      setTimeout(() => {
        const indices = slotStates.map(s => s.storyIndex);
        let next = (Math.max(...indices) + 1) % total;
        while (indices.includes(next)) next = (next + 1) % total;
        setSlotStates(prev => {
          const ns = [...prev];
          ns[slotToUpdate] = { storyIndex: next, phase: 'dark' };
          return ns;
        });
        setTimeout(() => {
          setSlotStates(prev => {
            const ns = [...prev];
            ns[slotToUpdate] = { ...ns[slotToUpdate], phase: 'brightening' };
            return ns;
          });
          setTimeout(() => {
            setSlotStates(prev => {
              const ns = [...prev];
              ns[slotToUpdate] = { ...ns[slotToUpdate], phase: 'visible' };
              return ns;
            });
          }, 2000);
        }, 50);
      }, 3000);
      setNextSlotToUpdate(p => (p + 1) % 4);
    }, 15000);
    return () => clearInterval(interval);
  }, [total, nextSlotToUpdate, slotStates]);

  const handlePrev = () => setSlotStates(prev => prev.map(s => ({ storyIndex: (s.storyIndex - 1 + total) % total, phase: 'visible' })));
  const handleNext = () => setSlotStates(prev => prev.map(s => ({ storyIndex: (s.storyIndex + 1) % total, phase: 'visible' })));

  const getStyle = (phase: string) => {
    switch (phase) {
      case 'darkening': return { filter: 'brightness(0)', transition: 'filter 3s ease-in-out' };
      case 'dark': return { filter: 'brightness(0)', transition: 'none' };
      case 'brightening': return { filter: 'brightness(1)', transition: 'filter 2s ease-in-out' };
      default: return { filter: 'brightness(1)', transition: 'filter 2s ease-in-out' };
    }
  };

  if (total === 0) {
    return (
      <div className="text-center text-slate-500 text-xs py-8">
        No stories scored yet for your priorities. Scoring runs after each scrape cycle (~10 min). After editing your priorities below, allow ~1 minute for re-scoring.
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-2">
        {slotStates.map((slot, i) => {
          const story = limited[slot.storyIndex];
          if (!story) return null;
          return (
            <div key={i} className="relative" style={getStyle(slot.phase)}>
              <StoryCard story={story} slug={slug} isAdmin={isAdmin} isVisible={true} />
            </div>
          );
        })}
      </div>
      {total > 4 && (
        <>
          <button onClick={handlePrev} className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 bg-slate-700/80 hover:bg-slate-600 rounded-full p-1.5 text-white shadow-lg" data-testid="carousel-prev">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={handleNext} className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 bg-slate-700/80 hover:bg-slate-600 rounded-full p-1.5 text-white shadow-lg" data-testid="carousel-next">
            <ChevronRight className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
}

function ScreenshotCard({ shot }: { shot: CustomMcopScreenshot }) {
  const Wrap = shot.linkUrl
    ? ({ children }: any) => <a href={shot.linkUrl!} target="_blank" rel="noopener noreferrer" className="block">{children}</a>
    : ({ children }: any) => <div>{children}</div>;
  return (
    <Wrap>
      <div className="rounded-lg overflow-hidden bg-slate-800/50 hover:bg-slate-700/50 transition-colors" data-testid={`mcop-screenshot-${shot.id}`}>
        <img src={shot.imageUrl} alt={shot.caption} className="w-full object-cover" />
        {shot.sourceLabel && (
          <div className="px-2 py-1 text-[10px] text-slate-400 truncate">{shot.sourceLabel}</div>
        )}
      </div>
    </Wrap>
  );
}

function TruthSocialCard({ post, slug, isAdmin }: { post: TruthSocialPost; slug: string; isAdmin: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  const mediaUrl = post.imageUrl;
  const cleanContent = cleanTruthContent(post.content).replace(/https?:\/\/[^\s]+/g, '').trim();
  const showContent = cleanContent && cleanContent !== '[Media attachment]';
  return (
    <a href={post.truthSocialUrl} target="_blank" rel="noopener noreferrer"
      className="relative block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 border border-slate-700/50"
      data-testid={`mcop-truth-${post.id}`}>
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-red-500 to-blue-600 flex items-center justify-center text-white font-bold text-xs">P</div>
          <div>
            <div className="text-xs font-bold text-white">POTUS</div>
            <div className="text-[10px] text-slate-400">@realDonaldTrump</div>
          </div>
          <div className="ml-auto text-[10px] text-slate-500 flex items-center gap-1">
            <span className="text-red-400 font-bold">Truth.</span>
            {formatTimeAgo(new Date(post.postedAt))}
          </div>
        </div>
        {showContent && <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">{cleanContent}</p>}
        {mediaUrl && !imgFailed && (
          <div className="mt-2 rounded-lg overflow-hidden">
            <img src={mediaUrl} alt="" className="w-full h-auto max-h-48 object-contain bg-black/20"
              loading="lazy" onError={() => setImgFailed(true)} />
          </div>
        )}
      </div>
    </a>
  );
}

function getXAccountStyle(account: string) {
  switch (account) {
    case 'SecWar': return { initial: 'S', name: '@SecWar', gradient: 'from-blue-500 to-indigo-600' };
    case 'PeteHegseth': return { initial: 'P', name: '@PeteHegseth', gradient: 'from-amber-500 to-yellow-600' };
    case 'SeanParnellASW': return { initial: 'S', name: '@SeanParnellASW', gradient: 'from-sky-500 to-blue-600' };
    case 'DOWResponse': return { initial: 'D', name: '@DOWResponse', gradient: 'from-red-500 to-rose-600' };
    case 'TheJointStaff': return { initial: 'J', name: '@TheJointStaff', gradient: 'from-indigo-500 to-purple-700' };
    case 'SecArmy': return { initial: 'A', name: '@SecArmy', gradient: 'from-green-700 to-emerald-800' };
    case 'SecAFOfficial': return { initial: 'F', name: '@SecAFOfficial', gradient: 'from-cyan-600 to-sky-700' };
    case 'SecRubio': return { initial: 'R', name: '@SecRubio', gradient: 'from-violet-500 to-purple-600' };
    case 'SenMarcoRubio': return { initial: 'M', name: '@SenMarcoRubio', gradient: 'from-rose-500 to-pink-600' };
    case 'PressSec': return { initial: 'P', name: '@PressSec', gradient: 'from-fuchsia-500 to-pink-600' };
    case 'kleavittnh': return { initial: 'K', name: '@kleavittnh', gradient: 'from-pink-500 to-rose-600' };
    case 'Rapidresponse47': return { initial: 'R', name: '@Rapidresponse47', gradient: 'from-orange-500 to-red-600' };
    case 'sentdefender': return { initial: 'S', name: '@sentdefender', gradient: 'from-emerald-500 to-teal-600' };
    default: return { initial: account?.charAt(0)?.toUpperCase() || 'X', name: `@${account || 'X'}`, gradient: 'from-blue-500 to-purple-600' };
  }
}

function XPostCard({ post, slug, isAdmin }: { post: EnhancedXPost; slug: string; isAdmin: boolean }) {
  const cleanContent = post.content.replace(/https?:\/\/[^\s]+/g, '').trim();
  const style = getXAccountStyle(post.sourceAccount || 'X');
  return (
    <a href={post.xUrl} target="_blank" rel="noopener noreferrer"
      className="relative block bg-slate-800/50 rounded-xl overflow-hidden hover:bg-slate-700/50 border border-slate-700/50"
      data-testid={`mcop-x-${post.id}`}>
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${style.gradient} flex items-center justify-center text-white font-bold text-xs`}>
            {style.initial}
          </div>
          <div>
            <div className="text-xs font-bold text-white">{style.name}</div>
          </div>
          <div className="ml-auto text-[10px] text-slate-500 flex items-center gap-1">
            <span className="font-bold">X</span>{formatTimeAgo(new Date(post.postedAt))}
          </div>
        </div>
        <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">{cleanContent || post.content}</p>
        {post.imageUrl && (
          <div className="mt-2 rounded-lg overflow-hidden">
            <img src={post.imageUrl} alt="" className="w-full h-auto max-h-48 object-cover" />
          </div>
        )}
      </div>
    </a>
  );
}

function FirstAlertCard({ alert }: { alert: FirstAlert }) {
  const isUrgent = alert.alertType === 'Urgent' || alert.alertType === 'Flash';
  return (
    <a href={alert.url} target="_blank" rel="noopener noreferrer"
      className={`block rounded-xl p-3 border ${isUrgent ? 'bg-red-900/30 border-red-700/50 hover:bg-red-800/30' : 'bg-slate-800/50 border-slate-700/50 hover:bg-slate-700/50'}`}
      data-testid={`mcop-alert-${alert.id}`}>
      <div className="flex items-start gap-2 mb-2">
        {isUrgent && <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />}
        <p className="text-xs text-slate-200 font-medium leading-tight line-clamp-3">{alert.headline}</p>
      </div>
      {alert.location && (
        <div className="flex items-center gap-1 text-[10px] text-slate-400 mt-1">
          <MapPin className="w-3 h-3" /><span className="line-clamp-1">{alert.location}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mt-2 text-[10px] text-slate-500">
        {alert.alertLists && alert.alertLists.length > 0 && (
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{alert.alertLists[0]}</span>
        )}
        <span className="ml-auto">{formatTimeAgo(new Date(alert.publishedAt))}</span>
      </div>
    </a>
  );
}

export default function CustomMcop() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  return (
    <WarfighterGate
      slug={slug}
      mode="viewer"
      storageKey={`${slug ?? 'mcop'}-viewer-unlocked`}
      title={`${slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'MCOP'} Dashboard`}
      subtitle="Enter the password to access this dashboard."
    >
      <CustomMcopInner slug={slug} />
    </WarfighterGate>
  );
}

function CustomMcopInner({ slug }: { slug: string | undefined }) {

  const { data: feed, isLoading } = useQuery<FeedData>({
    queryKey: ['/api/custom-mcops', slug, 'feed'],
    refetchInterval: 60000,
    enabled: !!slug,
  });

  const [selectedAlertLists, setSelectedAlertLists] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(`mcop:${slug}:alertLists`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [listFilterOpen, setListFilterOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(`mcop:${slug}:alertLists`, JSON.stringify(selectedAlertLists)); } catch {}
  }, [selectedAlertLists, slug]);

  const isCyber = slug === 'cyber';
  const [showTopStories, setShowTopStories] = useState(true);
  const [showTruthSocial, setShowTruthSocial] = useState(true);
  const [showXFeeds, setShowXFeeds] = useState(true);
  const [showFirstAlert, setShowFirstAlert] = useState(() => {
    const defaultOn = slug === 'cyber';
    try {
      const saved = localStorage.getItem(`mcop:${slug}:showFirstAlert`);
      return saved === null ? defaultOn : saved === 'true';
    } catch { return defaultOn; }
  });
  useEffect(() => {
    try { localStorage.setItem(`mcop:${slug}:showFirstAlert`, String(showFirstAlert)); } catch {}
  }, [showFirstAlert, slug]);
  const [showInfluencerXPosts, setShowInfluencerXPosts] = useState(() => {
    try {
      const saved = localStorage.getItem(`mcop:${slug}:showInfluencerXPosts`);
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(`mcop:${slug}:showInfluencerXPosts`, String(showInfluencerXPosts)); } catch {}
  }, [showInfluencerXPosts, slug]);

  const visibleXAccounts = useMemo(() => {
    const enabled = feed?.enabledXAccounts;
    if (!enabled) return X_ACCOUNTS;
    const set = new Set(enabled);
    return X_ACCOUNTS.filter(a => set.has(a.id));
  }, [feed?.enabledXAccounts]);

  const [selectedXAccounts, setSelectedXAccounts] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`mcop:${slug}:xAccounts`);
      if (saved) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(X_ACCOUNTS.map(a => a.id));
  });
  const [xFilterOpen, setXFilterOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(`mcop:${slug}:xAccounts`, JSON.stringify(Array.from(selectedXAccounts))); } catch {}
  }, [selectedXAccounts, slug]);
  const toggleXAccount = (id: string) => {
    setSelectedXAccounts(prev => {
      const ns = new Set(prev);
      if (ns.has(id)) ns.delete(id); else ns.add(id);
      return ns;
    });
  };

  const visibleInfluencerXAccounts = useMemo(() => {
    const enabled = feed?.enabledInfluencerXAccounts;
    if (!enabled) return INFLUENCER_X_ACCOUNTS;
    const set = new Set(enabled);
    return INFLUENCER_X_ACCOUNTS.filter(a => set.has(a.id));
  }, [feed?.enabledInfluencerXAccounts]);

  const [selectedInfluencerXAccounts, setSelectedInfluencerXAccounts] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`mcop:${slug}:influencerXAccounts`);
      if (saved) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(INFLUENCER_X_ACCOUNTS.map(a => a.id));
  });
  const [influencerXFilterOpen, setInfluencerXFilterOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(`mcop:${slug}:influencerXAccounts`, JSON.stringify(Array.from(selectedInfluencerXAccounts))); } catch {}
  }, [selectedInfluencerXAccounts, slug]);
  const toggleInfluencerXAccount = (id: string) => {
    setSelectedInfluencerXAccounts(prev => {
      const ns = new Set(prev);
      if (ns.has(id)) ns.delete(id); else ns.add(id);
      return ns;
    });
  };

  const [mcopBotOpen, setMcopBotOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);

  const filteredXPosts = useMemo(() => {
    const posts = feed?.xPosts || [];
    const visibleIds = new Set(visibleXAccounts.map(a => a.id));
    const effectiveSelection = new Set(
      Array.from(selectedXAccounts).filter(id => visibleIds.has(id))
    );
    if (effectiveSelection.size === 0) return [];
    return posts.filter(p => effectiveSelection.has(p.sourceAccount));
  }, [feed?.xPosts, selectedXAccounts, visibleXAccounts]);

  const filteredInfluencerXPosts = useMemo(() => {
    const posts = feed?.influencerXPosts || [];
    const visibleIds = new Set(visibleInfluencerXAccounts.map(a => a.id));
    const effectiveSelection = new Set(
      Array.from(selectedInfluencerXAccounts).filter(id => visibleIds.has(id))
    );
    if (effectiveSelection.size === 0) return [];
    return posts.filter(p => effectiveSelection.has(p.sourceAccount));
  }, [feed?.influencerXPosts, selectedInfluencerXAccounts, visibleInfluencerXAccounts]);

  const filteredAlerts = useMemo(() => {
    const alerts = feed?.firstAlerts || [];
    let list = alerts;
    if (selectedAlertLists.length > 0) {
      list = alerts.filter(a => a.alertLists?.some(l => selectedAlertLists.includes(l)));
    }
    return [...list].sort((a, b) => {
      const af = a.alertType === 'Flash', bf = b.alertType === 'Flash';
      if (af && !bf) return -1;
      if (!af && bf) return 1;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
  }, [feed?.firstAlerts, selectedAlertLists]);

  const availableAlertLists = useMemo(() => {
    const predefined = ["Global Terrorism and Mass Violence", "Israel/Hamas", "China", "Five Eyes + NATO", "Russia/Ukraine", "US Politics and Military Affairs", "Worldwide Flash"];
    const counts = new Map<string, number>();
    feed?.firstAlerts?.forEach(a => a.alertLists?.forEach(l => counts.set(l, (counts.get(l) || 0) + 1)));
    return predefined.map(name => ({ name, count: counts.get(name) || 0 }));
  }, [feed?.firstAlerts]);

  const searchResults = useMemo(() => {
    const q = headerSearchQuery.trim().toLowerCase();
    if (!q) return [] as StreamHeadline[];
    return (feed?.topStories || []).filter(h =>
      h.title.toLowerCase().includes(q) ||
      (h.source && h.source.toLowerCase().includes(q)) ||
      (h.summary && h.summary.toLowerCase().includes(q))
    );
  }, [headerSearchQuery, feed?.topStories]);

  if (isLoading || !feed) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const isAdmin = !!feed.isMcopAdmin;

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-700/50 bg-slate-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-[1920px] mx-auto px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Shield className="h-6 w-6 text-blue-500" />
              <h1 className="text-lg font-bold tracking-tight uppercase" data-testid="text-mcop-name">
                {feed.mcop.name.toUpperCase()} DASHBOARD
              </h1>
              <span className="text-xs text-slate-500">Custom MCOP · {feed.scoredCount} scored</span>
            </div>
            <div className="flex items-center gap-3">
              <Link href={`/mcop/${slug}/admin`}>
                <span className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer" data-testid="link-mcop-admin">
                  <Settings className="h-3.5 w-3.5" /> Admin
                </span>
              </Link>
              <button
                onClick={() => setMcopBotOpen(true)}
                className="flex items-center gap-2 hover:bg-slate-700/50 rounded-full px-3 py-1 transition-colors"
                data-testid="mcop-button-mcopBot"
              >
                <img src={mcopBotIcon} alt="MCOP Bot" className="w-7 h-7 object-cover rounded-full" />
                <span className="text-xs font-medium text-blue-400">Ask MCOP Bot</span>
              </button>
              <div className="flex gap-1.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                  <Input
                    placeholder="Search top stories..."
                    value={headerSearchQuery}
                    onChange={(e) => setHeaderSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && headerSearchQuery.trim()) {
                        e.preventDefault();
                        setSearchDialogOpen(true);
                      }
                    }}
                    className="pl-8 w-40 h-8 text-xs bg-slate-800 border-slate-600 text-slate-200 placeholder:text-slate-500"
                    data-testid="mcop-input-search"
                  />
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => headerSearchQuery.trim() && setSearchDialogOpen(true)}
                  disabled={!headerSearchQuery.trim()}
                  className="h-8 w-8 border-slate-600 text-slate-400 hover:text-white"
                  data-testid="mcop-button-search"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ThemeToggle />
              <Link href="/team">
                <span className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer" data-testid="link-back-team">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to Team
                </span>
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 pt-2 border-t border-slate-700/30">
            <span className="text-xs font-medium text-slate-400">Show Columns:</span>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input type="checkbox" checked={showTopStories} onChange={(e) => setShowTopStories(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-blue-500" data-testid="mcop-toggle-top-stories" />
              <span className="text-xs text-slate-300">Top Stories</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input type="checkbox" checked={showTruthSocial} onChange={(e) => setShowTruthSocial(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-blue-500" data-testid="mcop-toggle-truth-social" />
              <span className="text-xs text-slate-300">POTUS Truth Social</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input type="checkbox" checked={showXFeeds} onChange={(e) => setShowXFeeds(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-blue-500" data-testid="mcop-toggle-x-feeds" />
              <span className="text-xs text-slate-300">X Feeds</span>
            </label>
            {!isCyber && (
              <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
                <input type="checkbox" checked={showInfluencerXPosts} onChange={(e) => setShowInfluencerXPosts(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-blue-500" data-testid="mcop-toggle-influencer-x-posts" />
                <span className="text-xs text-slate-300">Influencer X Posts</span>
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-700/30 px-2 py-1 rounded">
              <input type="checkbox" checked={showFirstAlert} onChange={(e) => setShowFirstAlert(e.target.checked)} className="w-3.5 h-3.5 cursor-pointer accent-blue-500" data-testid="mcop-toggle-first-alert" />
              <span className="text-xs text-slate-300">DATAMINR</span>
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-[1920px] mx-auto p-4">
        <div className="flex gap-4 h-[calc(100vh-140px)]">
          {showTopStories && (
            <div className="flex-[3] min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                  TOP STORIES <span className="text-slate-500 font-normal">(RANKED FOR YOU)</span>
                </h2>
                <ExternalLink className="w-4 h-4 text-slate-500" />
              </div>
              <div className="flex-1 bg-slate-800/30 rounded-2xl p-3 border border-slate-700/30 overflow-y-auto">
                <TopStoriesCarousel stories={feed.topStories} slug={slug!} isAdmin={isAdmin} />
              </div>
            </div>
          )}

          {showTruthSocial && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">POTUS TRUTH SOCIAL</h2>
                <span className="text-red-400 font-bold text-xs">Truth.</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {feed.truthSocialPosts.slice(0, 10).map(p => (
                  <TruthSocialCard key={p.id} post={p} slug={slug!} isAdmin={isAdmin} />
                ))}
              </div>
            </div>
          )}

          {showXFeeds && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">X FEEDS</h2>
                <div className="relative">
                  <button
                    onClick={() => setXFilterOpen(!xFilterOpen)}
                    className="text-[10px] bg-slate-700/50 hover:bg-slate-600/50 px-2 py-1 rounded flex items-center gap-1"
                    data-testid="mcop-x-filter-button"
                  >
                    Filter ({Array.from(selectedXAccounts).filter(id => visibleXAccounts.some(a => a.id === id)).length}/{visibleXAccounts.length})
                  </button>
                  {xFilterOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 min-w-[160px]">
                      {visibleXAccounts.length === 0 && (
                        <div className="px-3 py-2 text-xs text-slate-400">No X accounts enabled by admin.</div>
                      )}
                      {visibleXAccounts.map(account => (
                        <label key={account.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-700/50 cursor-pointer text-xs">
                          <input
                            type="checkbox"
                            checked={selectedXAccounts.has(account.id)}
                            onChange={() => toggleXAccount(account.id)}
                            className="rounded border-slate-500"
                            data-testid={`mcop-x-filter-${account.id}`}
                          />
                          {account.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {(feed.screenshots || []).map(s => <ScreenshotCard key={s.id} shot={s} />)}
                {filteredXPosts.slice(0, 15).map(p => (
                  <XPostCard key={p.id} post={p} slug={slug!} isAdmin={isAdmin} />
                ))}
                {filteredXPosts.length === 0 && (feed.screenshots || []).length === 0 && (
                  <div className="text-center text-slate-500 text-xs py-4">No accounts selected</div>
                )}
              </div>
            </div>
          )}

          {showInfluencerXPosts && !isCyber && (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">INFLUENCER X POSTS</h2>
                <div className="relative">
                  <button
                    onClick={() => setInfluencerXFilterOpen(!influencerXFilterOpen)}
                    className="text-[10px] bg-slate-700/50 hover:bg-slate-600/50 px-2 py-1 rounded flex items-center gap-1"
                    data-testid="mcop-influencer-x-filter-button"
                  >
                    Filter ({Array.from(selectedInfluencerXAccounts).filter(id => visibleInfluencerXAccounts.some(a => a.id === id)).length}/{visibleInfluencerXAccounts.length})
                  </button>
                  {influencerXFilterOpen && (
                    <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 min-w-[160px] max-h-80 overflow-y-auto">
                      {visibleInfluencerXAccounts.map(account => (
                        <label key={account.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-700/50 cursor-pointer text-xs">
                          <input
                            type="checkbox"
                            checked={selectedInfluencerXAccounts.has(account.id)}
                            onChange={() => toggleInfluencerXAccount(account.id)}
                            className="rounded border-slate-500"
                            data-testid={`mcop-influencer-x-filter-${account.id}`}
                          />
                          {account.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {filteredInfluencerXPosts.slice(0, 30).map(p => (
                  <XPostCard key={p.id} post={p} slug={slug!} isAdmin={isAdmin} />
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
                  <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">DATAMINR</h2>
                  <Button size="icon" variant="ghost" onClick={() => setListFilterOpen(true)} className="h-6 w-6" data-testid="button-mcop-filter-lists">
                    <Filter className="h-3 w-3" />
                  </Button>
                </div>
                <span className="text-xs text-slate-500">{filteredAlerts.length} alerts</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {filteredAlerts.slice(0, 30).map(a => <FirstAlertCard key={a.id} alert={a} />)}
              </div>
            </div>
          )}

          {!showTopStories && !showTruthSocial && !showXFeeds && (isCyber || !showInfluencerXPosts) && !showFirstAlert && (
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
            <DialogTitle data-testid="mcop-search-dialog-title">
              Search Results for "{headerSearchQuery}" ({searchResults.length} found)
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            <div className="space-y-2 pr-2">
              {searchResults.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No results found in your top stories matching "{headerSearchQuery}"
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground border-b pb-1">
                    <Newspaper className="w-3 h-3" />
                    <span>Headlines ({searchResults.length})</span>
                  </div>
                  {searchResults.map(headline => (
                    <a key={headline.id} href={headline.url} target="_blank" rel="noopener noreferrer"
                      className="block p-3 rounded-md border hover-elevate"
                      data-testid={`mcop-search-result-${headline.id}`}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <h3 className="text-sm font-medium line-clamp-2">{headline.title}</h3>
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            <span>{headline.source}</span>
                          </div>
                        </div>
                        <ExternalLink className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                      </div>
                    </a>
                  ))}
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
