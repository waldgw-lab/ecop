import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Trash2, RotateCcw, Pencil, Check, X, Settings2, Layers, Unlink, Star, GitMerge, RefreshCw, Plus, FolderPlus, ToggleLeft, ToggleRight } from "lucide-react";
import type { Headline } from "@shared/schema";

interface ClusterMember {
  id: string;
  title: string;
  source: string;
  url: string;
  priority: number;
  type: 'headline' | 'manual';
  isRepresentative: boolean;
}

interface Cluster {
  id: string;
  name: string;
  members: ClusterMember[];
}

interface HeadlineManagementDialogProps {
  trigger?: React.ReactNode;
}

export function HeadlineManagementDialog({ trigger }: HeadlineManagementDialogProps) {
  const [open, setOpen] = useState(false);
  const [editingPriorities, setEditingPriorities] = useState<Record<string, string>>({});
  const [editingTitles, setEditingTitles] = useState<Record<string, string>>({});
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("headlines");
  const [mergingClusterId, setMergingClusterId] = useState<string | null>(null);
  const [creatingClusterForItem, setCreatingClusterForItem] = useState<{ id: string; type: 'headline' | 'manual' } | null>(null);
  const [newClusterName, setNewClusterName] = useState("");
  const { toast } = useToast();

  const { data: headlineFeed18h = [] } = useQuery<Array<Headline & { pdfPath?: string | null; type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number }>>({
    queryKey: ['/api/headline-feed', { hours: 18 }],
    enabled: open,
  });

  const { data: headlineFeed48h = [] } = useQuery<Array<Headline & { pdfPath?: string | null; type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number }>>({
    queryKey: ['/api/headline-feed', { hours: 48 }],
    enabled: open,
  });

  const updatePriorityMutation = useMutation({
    mutationFn: async ({ id, priorityOverride, type }: { id: string; priorityOverride: number | null; type: 'scraped' | 'manual' }) => {
      await apiRequest('PATCH', `/api/admin/headlines/${id}/priority`, { priorityOverride, type });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Priority updated",
        description: "Headline priority has been updated",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: "Failed to update priority",
      });
    },
  });

  const updateTitleMutation = useMutation({
    mutationFn: async ({ id, title, type }: { id: string; title: string; type: 'scraped' | 'manual' }) => {
      await apiRequest('PATCH', `/api/admin/headlines/${id}/title`, { title, type });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Title updated",
        description: "Headline title has been updated",
      });
      setEditingTitleId(null);
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: "Failed to update title",
      });
    },
  });

  const blockMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/admin/headlines/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Headline blocked",
        description: "Headline has been removed and blocked from future scrapes",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Block failed",
        description: "Failed to block headline",
      });
    },
  });

  const { data: clusters = [], isLoading: clustersLoading, refetch: refetchClusters } = useQuery<Cluster[]>({
    queryKey: ['/api/clusters'],
    enabled: open,
  });

  const { data: clusterEnabledData } = useQuery<{ enabled: boolean }>({
    queryKey: ['/api/clusters/enabled'],
    enabled: open,
  });
  const clusteringEnabled = clusterEnabledData?.enabled ?? true;

  const toggleClusteringMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest('POST', '/api/clusters/toggle', { enabled });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/clusters/enabled'] });
      refetchClusters();
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: data.enabled ? "Auto-clustering enabled" : "Auto-clustering disabled",
        description: data.enabled ? "Headlines will be grouped automatically" : "All clusters cleared — headlines shown individually",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Toggle failed",
        description: "Failed to toggle clustering",
      });
    },
  });

  const runClusteringMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('POST', '/api/clusters/run');
    },
    onSuccess: () => {
      refetchClusters();
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Clustering complete",
        description: "Headlines have been re-clustered",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Clustering failed",
        description: "Failed to run clustering",
      });
    },
  });

  const setRepresentativeMutation = useMutation({
    mutationFn: async ({ clusterId, itemId, itemType }: { clusterId: string; itemId: string; itemType: string }) => {
      await apiRequest('POST', `/api/clusters/${clusterId}/representative`, { itemId, itemType });
    },
    onSuccess: () => {
      refetchClusters();
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Representative updated",
        description: "Cluster representative has been changed",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: "Failed to set representative",
      });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async ({ itemId, itemType }: { itemId: string; itemType: string }) => {
      await apiRequest('POST', '/api/clusters/unlink', { itemId, itemType });
    },
    onSuccess: () => {
      refetchClusters();
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Unlinked",
        description: "Item has been removed from the cluster",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Unlink failed",
        description: "Failed to unlink from cluster",
      });
    },
  });

  const mergeClustersMutation = useMutation({
    mutationFn: async ({ sourceClusterId, targetClusterId }: { sourceClusterId: string; targetClusterId: string }) => {
      await apiRequest('POST', '/api/clusters/merge', { sourceClusterId, targetClusterId });
    },
    onSuccess: () => {
      refetchClusters();
      setMergingClusterId(null);
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Clusters merged",
        description: "Clusters have been combined",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Merge failed",
        description: "Failed to merge clusters",
      });
    },
  });

  const createClusterMutation = useMutation({
    mutationFn: async ({ name, itemId, itemType }: { name: string; itemId: string; itemType: 'headline' | 'manual' }) => {
      await apiRequest('POST', '/api/clusters/create', { name, itemId, itemType });
    },
    onSuccess: () => {
      refetchClusters();
      setCreatingClusterForItem(null);
      setNewClusterName("");
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Cluster created",
        description: "New cluster has been created with this headline",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Creation failed",
        description: "Failed to create cluster",
      });
    },
  });

  const assignToClusterMutation = useMutation({
    mutationFn: async ({ clusterId, itemId, itemType }: { clusterId: string; itemId: string; itemType: 'headline' | 'manual' }) => {
      await apiRequest('POST', '/api/clusters/assign', { clusterId, itemId, itemType });
    },
    onSuccess: () => {
      refetchClusters();
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === '/api/headline-feed' });
      toast({
        title: "Headline assigned",
        description: "Headline has been added to the cluster",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Assignment failed",
        description: "Failed to assign headline to cluster",
      });
    },
  });

  const handlePriorityInputChange = (id: string, value: string) => {
    setEditingPriorities(prev => ({ ...prev, [id]: value }));
  };

  const handlePrioritySubmit = (id: string, type: 'scraped' | 'manual') => {
    const value = editingPriorities[id];
    if (value === undefined) return;

    const priorityOverride = value === '' ? null : parseInt(value);
    if (priorityOverride === null || (priorityOverride >= 1 && priorityOverride <= 100)) {
      updatePriorityMutation.mutate({ id, priorityOverride, type });
      setEditingPriorities(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleResetPriority = (id: string, type: 'scraped' | 'manual') => {
    updatePriorityMutation.mutate({ id, priorityOverride: null, type });
    setEditingPriorities(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleStartEditTitle = (id: string, currentTitle: string) => {
    setEditingTitleId(id);
    setEditingTitles(prev => ({ ...prev, [id]: currentTitle }));
  };

  const handleTitleChange = (id: string, value: string) => {
    setEditingTitles(prev => ({ ...prev, [id]: value }));
  };

  const handleTitleSubmit = (id: string, type: 'scraped' | 'manual') => {
    const newTitle = editingTitles[id];
    if (newTitle && newTitle.trim()) {
      updateTitleMutation.mutate({ id, title: newTitle.trim(), type });
    }
  };

  const handleCancelEditTitle = () => {
    setEditingTitleId(null);
  };

  const handleBlock = (id: string) => {
    if (confirm('Are you sure you want to block this headline? It will be removed and prevented from appearing in future scrapes.')) {
      blockMutation.mutate(id);
    }
  };

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const topStories = [...headlineFeed18h]
    .sort((a, b) => b.depreciatedPriority - a.depreciatedPriority)
    .slice(0, 8);

  const lastHourHeadlines = headlineFeed48h
    .filter(h => new Date(h.scrapedAt) > oneHourAgo)
    .sort((a, b) => b.depreciatedPriority - a.depreciatedPriority);

  const earlierTodayHeadlines = headlineFeed48h
    .filter(h => {
      const scrapedDate = new Date(h.scrapedAt);
      return scrapedDate >= startOfToday && scrapedDate <= oneHourAgo;
    })
    .sort((a, b) => b.depreciatedPriority - a.depreciatedPriority);

  const renderHeadlineRow = (headline: Headline & { type: 'scraped' | 'manual'; originalPriority: number; depreciatedPriority: number }) => {
    const hasOverride = headline.priorityOverride !== null && headline.priorityOverride !== undefined;
    const isManualSubmission = headline.source?.includes('(Manual)') ?? false;
    const isEditingTitle = editingTitleId === headline.id;

    return (
      <div
        key={headline.id}
        className="flex items-center gap-2 p-2 border rounded-md hover-elevate"
        data-testid={`headline-mgmt-row-${headline.id}`}
      >
        <div className="flex-1 min-w-0">
          {isEditingTitle ? (
            <div className="flex items-center gap-1">
              <Input
                value={editingTitles[headline.id] || ''}
                onChange={(e) => handleTitleChange(headline.id, e.target.value)}
                className="h-7 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleTitleSubmit(headline.id, headline.type);
                  } else if (e.key === 'Escape') {
                    handleCancelEditTitle();
                  }
                }}
                data-testid={`input-title-${headline.id}`}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleTitleSubmit(headline.id, headline.type)}
                className="flex-shrink-0"
                data-testid={`button-save-title-${headline.id}`}
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleCancelEditTitle}
                className="flex-shrink-0"
                data-testid={`button-cancel-title-${headline.id}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1 group">
              <a 
                href={headline.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-xs font-medium truncate flex-1 hover:underline hover:text-primary"
                title={headline.title}
                data-testid={`link-headline-${headline.id}`}
              >
                {headline.title}
              </a>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleStartEditTitle(headline.id, headline.title)}
                className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                title="Edit title"
                data-testid={`button-edit-title-${headline.id}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground truncate">
            {headline.source}
          </p>
        </div>
        
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min="1"
              max="100"
              value={editingPriorities[headline.id] !== undefined 
                ? editingPriorities[headline.id] 
                : (hasOverride ? (headline.priorityOverride ?? '') : '')}
              onChange={(e) => handlePriorityInputChange(headline.id, e.target.value)}
              onBlur={() => handlePrioritySubmit(headline.id, headline.type)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handlePrioritySubmit(headline.id, headline.type);
                }
              }}
              placeholder={headline.priorityScore.toString()}
              className="w-14 h-7 text-center text-xs"
              data-testid={`input-priority-mgmt-${headline.id}`}
            />
            {hasOverride && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleResetPriority(headline.id, headline.type)}
                title="Reset to AI priority"
                data-testid={`button-reset-mgmt-${headline.id}`}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            )}
          </div>
          
          <div className="text-xs text-center w-10">
            <div className="font-semibold">{headline.depreciatedPriority}</div>
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                title="Add to cluster"
                data-testid={`button-cluster-${headline.id}`}
              >
                <Layers className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onClick={() => {
                  setCreatingClusterForItem({ 
                    id: headline.id, 
                    type: headline.type === 'manual' ? 'manual' : 'headline' 
                  });
                }}
                data-testid={`menu-new-cluster-${headline.id}`}
              >
                <Plus className="h-4 w-4 mr-2" />
                Create new cluster
              </DropdownMenuItem>
              {clusters.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                    Add to existing cluster
                  </div>
                  {clusters.map((cluster) => (
                    <DropdownMenuItem
                      key={cluster.id}
                      onClick={() => {
                        assignToClusterMutation.mutate({
                          clusterId: cluster.id,
                          itemId: headline.id,
                          itemType: headline.type === 'manual' ? 'manual' : 'headline'
                        });
                      }}
                      data-testid={`menu-assign-cluster-${cluster.id}-${headline.id}`}
                    >
                      <FolderPlus className="h-4 w-4 mr-2" />
                      <span className="truncate">{cluster.name}</span>
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {cluster.members.length}
                      </Badge>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="icon"
            variant="destructive"
            onClick={() => handleBlock(headline.id)}
            title={isManualSubmission ? "Manual submissions cannot be blocked" : "Block headline"}
            data-testid={`button-block-mgmt-${headline.id}`}
            disabled={isManualSubmission}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  const renderClusterCard = (cluster: Cluster) => {
    const isMerging = mergingClusterId !== null;
    const isSourceCluster = mergingClusterId === cluster.id;

    return (
      <div
        key={cluster.id}
        className={`border rounded-md p-3 space-y-2 ${isSourceCluster ? 'border-primary bg-primary/10' : isMerging ? 'hover:border-primary/50 cursor-pointer' : ''}`}
        data-testid={`cluster-card-${cluster.id}`}
        onClick={isMerging && !isSourceCluster ? () => {
          mergeClustersMutation.mutate({
            sourceClusterId: mergingClusterId!,
            targetClusterId: cluster.id
          });
        } : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Layers className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium truncate" title={cluster.name}>
              {cluster.name}
            </span>
            <Badge variant="secondary" className="flex-shrink-0">
              {cluster.members.length}
            </Badge>
            {isSourceCluster && (
              <Badge variant="default" className="flex-shrink-0">Source</Badge>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {isMerging ? (
              !isSourceCluster && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={(e) => {
                    e.stopPropagation();
                    mergeClustersMutation.mutate({
                      sourceClusterId: mergingClusterId!,
                      targetClusterId: cluster.id
                    });
                  }}
                  disabled={mergeClustersMutation.isPending}
                  data-testid={`button-merge-into-${cluster.id}`}
                >
                  <GitMerge className="h-3 w-3 mr-1" />
                  Merge Here
                </Button>
              )
            ) : (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setMergingClusterId(cluster.id)}
                title="Merge with another cluster"
                data-testid={`button-start-merge-${cluster.id}`}
              >
                <GitMerge className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-1 pl-6">
          {cluster.members.map((member) => (
            <div
              key={`${member.type}-${member.id}`}
              className={`flex items-center gap-2 p-2 rounded-md text-xs ${member.isRepresentative ? 'bg-primary/10 border border-primary/20' : 'hover-elevate'}`}
              data-testid={`cluster-member-${member.id}`}
            >
              {member.isRepresentative && (
                <Star className="h-3 w-3 text-primary flex-shrink-0" fill="currentColor" />
              )}
              <div className="flex-1 min-w-0">
                <a 
                  href={member.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="truncate font-medium block hover:underline hover:text-primary"
                  title={member.title}
                  data-testid={`link-cluster-member-${member.id}`}
                >
                  {member.title}
                </a>
                <p className="text-muted-foreground">{member.source} | Priority: {member.priority}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {!member.isRepresentative && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setRepresentativeMutation.mutate({
                        clusterId: cluster.id,
                        itemId: member.id,
                        itemType: member.type
                      })}
                      disabled={setRepresentativeMutation.isPending}
                      title="Make representative"
                      data-testid={`button-set-rep-${member.id}`}
                    >
                      <Star className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => unlinkMutation.mutate({
                        itemId: member.id,
                        itemType: member.type
                      })}
                      disabled={unlinkMutation.isPending}
                      title="Remove from cluster"
                      data-testid={`button-unlink-${member.id}`}
                    >
                      <Unlink className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" data-testid="button-headline-management">
            <Settings2 className="h-4 w-4 mr-2" />
            Headline Management
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Headline Management</DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="headlines" data-testid="tab-headlines">Headlines</TabsTrigger>
            <TabsTrigger value="clusters" data-testid="tab-clusters">
              <Layers className="h-4 w-4 mr-2" />
              Clusters ({clusters.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="headlines">
            <div className="overflow-auto max-h-[65vh] pr-2">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 pb-1 border-b">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Top Stories
                    </h3>
                    <span className="text-xs text-muted-foreground">({topStories.length})</span>
                  </div>
                  {topStories.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No top stories</p>
                  ) : (
                    <div className="space-y-1">
                      {topStories.map(renderHeadlineRow)}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2 pb-1 border-b">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Last Hour
                    </h3>
                    <span className="text-xs text-muted-foreground">({lastHourHeadlines.length})</span>
                  </div>
                  {lastHourHeadlines.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No headlines from the last hour</p>
                  ) : (
                    <div className="space-y-1">
                      {lastHourHeadlines.map(renderHeadlineRow)}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2 pb-1 border-b">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Earlier Today
                    </h3>
                    <span className="text-xs text-muted-foreground">({earlierTodayHeadlines.length})</span>
                  </div>
                  {earlierTodayHeadlines.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No headlines from earlier today</p>
                  ) : (
                    <div className="space-y-1">
                      {earlierTodayHeadlines.map(renderHeadlineRow)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="clusters">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  AI groups similar headlines covering the same news event. Only the cluster representative is shown in Top Stories.
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    variant={clusteringEnabled ? "default" : "outline"}
                    onClick={() => toggleClusteringMutation.mutate(!clusteringEnabled)}
                    disabled={toggleClusteringMutation.isPending}
                    data-testid="button-toggle-clustering"
                  >
                    {toggleClusteringMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : clusteringEnabled ? (
                      <ToggleRight className="h-4 w-4 mr-2" />
                    ) : (
                      <ToggleLeft className="h-4 w-4 mr-2" />
                    )}
                    {clusteringEnabled ? "On" : "Off"}
                  </Button>
                  {clusteringEnabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runClusteringMutation.mutate()}
                      disabled={runClusteringMutation.isPending}
                      data-testid="button-run-clustering"
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${runClusteringMutation.isPending ? 'animate-spin' : ''}`} />
                      Re-cluster
                    </Button>
                  )}
                </div>
              </div>
              {mergingClusterId && (
                <div className="bg-primary/10 border border-primary/30 rounded-md p-3 flex items-center justify-between">
                  <p className="text-sm font-medium">Select a cluster to merge into, or click Cancel to exit merge mode.</p>
                  <Button size="sm" variant="outline" onClick={() => setMergingClusterId(null)}>
                    <X className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                </div>
              )}
              <div className="overflow-auto max-h-[55vh] pr-2">
                {clustersLoading ? (
                  <p className="text-sm text-muted-foreground italic text-center py-8">Loading clusters...</p>
                ) : clusters.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic text-center py-8">
                    No clusters found. Click "Re-cluster" to group similar headlines.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {clusters.map(renderClusterCard)}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
      
      <Dialog open={creatingClusterForItem !== null} onOpenChange={(open) => {
        if (!open) {
          setCreatingClusterForItem(null);
          setNewClusterName("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Cluster</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cluster-name">Cluster Name</Label>
              <Input
                id="cluster-name"
                value={newClusterName}
                onChange={(e) => setNewClusterName(e.target.value)}
                placeholder="e.g., Pentagon Budget 2026"
                data-testid="input-new-cluster-name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newClusterName.trim() && creatingClusterForItem) {
                    createClusterMutation.mutate({
                      name: newClusterName.trim(),
                      itemId: creatingClusterForItem.id,
                      itemType: creatingClusterForItem.type
                    });
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                This name will be used by AI to match similar headlines automatically.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setCreatingClusterForItem(null);
                  setNewClusterName("");
                }}
                data-testid="button-cancel-new-cluster"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (newClusterName.trim() && creatingClusterForItem) {
                    createClusterMutation.mutate({
                      name: newClusterName.trim(),
                      itemId: creatingClusterForItem.id,
                      itemType: creatingClusterForItem.type
                    });
                  }
                }}
                disabled={!newClusterName.trim() || createClusterMutation.isPending}
                data-testid="button-create-cluster"
              >
                {createClusterMutation.isPending ? "Creating..." : "Create Cluster"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
